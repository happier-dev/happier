import { readCapturePrivacyActive, subscribeCapturePrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { captureServerProfileScopeResolver, getActiveServerId, getServerProfileLegacyServerIds, getServerProfilesGeneration, subscribeActiveServer, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storageStore';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { ALL_SESSIONS_RECORDING_VISIBLE, createSessionRecordingVisibility, type SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';
import { readSettingWithPreview, settingsPreviewScopeMatches, useSettingsPreviewStore } from './settingsPreview';

const PRIVACY_SETTING = 'sessionListHiddenTagIdsWhileRecording';
const NO_TAGS: readonly string[] = [];
type Inputs = readonly [ReturnType<typeof readHiddenTags>, ReturnType<ReturnType<typeof getStorage>['getState']>['sessionOrganizationTagAssignmentsBySessionKey'], boolean, string, number];
let previousInputs: Inputs | undefined;
let previousVisibility: SessionRecordingVisibility = ALL_SESSIONS_RECORDING_VISIBLE;

function readHiddenTags() { return readSettingWithPreview(PRIVACY_SETTING); }
function hasHiddenTags(): boolean { return Object.values(readHiddenTags()).some(tags => tags.length > 0); }

/** Synchronous snapshot for incidental identity sources; explicit addresses preserve Home isolation. */
export function readSessionRecordingVisibility(): SessionRecordingVisibility {
    const hiddenTags = readHiddenTags();
    const recording = Object.values(hiddenTags).some(tags => tags.length > 0) && readCapturePrivacyActive();
    if (!recording) {
        previousInputs = undefined;
        previousVisibility = ALL_SESSIONS_RECORDING_VISIBLE;
        return previousVisibility;
    }
    const assignments = getStorage().getState().sessionOrganizationTagAssignmentsBySessionKey;
    const activeServerId = getActiveServerId();
    const inputs: Inputs = [hiddenTags, assignments, recording, activeServerId, getServerProfilesGeneration()];
    if (previousInputs?.every((input, index) => input === inputs[index])) return previousVisibility;
    previousInputs = inputs;
    const resolveHome = captureServerProfileScopeResolver();
    const assignmentHomes = new Map<string, readonly string[]>();
    for (const home of Object.keys(hiddenTags)) {
        const canonical = resolveHome(home);
        assignmentHomes.set(canonical, [canonical, ...getServerProfileLegacyServerIds(canonical).filter(id => id !== canonical)]);
    }
    previousVisibility = createSessionRecordingVisibility(recording, hiddenTags, address => {
        // Organization writers retain profile-local keys. Canonical entries (including an
        // explicit empty assignment) win; known profile aliases serve retained records.
        for (const home of assignmentHomes.get(address.serverId) ?? [address.serverId]) {
            const assignment = assignments[buildSessionOrganizationSessionKey(home, address.sessionId)];
            if (assignment) return assignment.tagIds;
        }
        return NO_TAGS;
    }, activeServerId, resolveHome);
    return previousVisibility;
}

/** Push invalidation is scoped to privacy inputs; native demand exists only while tags are selected. */
export function subscribeSessionRecordingVisibility(listener: () => void): () => void {
    let snapshot = readSessionRecordingVisibility();
    let stopCapture: (() => void) | undefined;
    const notify = () => {
        const next = readSessionRecordingVisibility();
        if (next === snapshot) return;
        snapshot = next;
        listener();
    };
    const updateDemand = () => {
        if (hasHiddenTags()) stopCapture ??= subscribeCapturePrivacyActive(notify);
        else { stopCapture?.(); stopCapture = undefined; }
        notify();
    };
    const storage = getStorage();
    const stopStorage = storage.subscribe(updateDemand, {
        settings: [PRIVACY_SETTING], settingsScope: true, sessionOrganizationTagAssignmentsBySessionKey: true,
    });
    const stopPreview = useSettingsPreviewStore.subscribe((state, previous) => {
        const scope = storage.getState().settingsScope;
        const entry = settingsPreviewScopeMatches(scope, state.scope) ? state.account[PRIVACY_SETTING] : undefined;
        const before = settingsPreviewScopeMatches(scope, previous.scope) ? previous.account[PRIVACY_SETTING] : undefined;
        if (entry !== before) updateDemand();
    });
    const stopActive = subscribeActiveServer(notify);
    const stopProfiles = subscribeServerProfiles(notify);
    updateDemand();
    return () => { stopStorage(); stopPreview(); stopActive(); stopProfiles(); stopCapture?.(); };
}
