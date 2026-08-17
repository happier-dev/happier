import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles, removeServerProfile, type ActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { listServerProfileScopeIds } from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import { storage } from '@/sync/domains/state/storage';
import { deleteServerFeaturesSnapshot, primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

import { enterDemoMode, exitDemoMode, isDemoModeActive } from '../runtime/enterExitDemoMode';
import { buildDemoWorld, type DemoWorld } from '../world/buildDemoWorld';
import { DEMO_SERVER_BASE_URL } from '../world/constants';
import {
    startDemoRuntimeResidueTracking,
    stopDemoRuntimeResidueTracking,
    type DemoRuntimeResidueFinding,
    type DemoRuntimeResidueMode,
} from './runtimeResidue';
import { buildStoreStateAfterDemoRestore, takeStoreSnapshot, type StoreSnapshot } from './storeSnapshot';

type ActiveDemoSnapshot = Readonly<{
    snapshot: StoreSnapshot;
    sessionIds: ReadonlySet<string>;
    machineIds: ReadonlySet<string>;
    activeServerSnapshot: ActiveServerSnapshot;
    demoServerProfileId: string;
    demoServerProfileExisted: boolean;
    primedServerFeatureIds: readonly string[];
    residuePolicy: DemoWorldResiduePolicy;
}>;

let activeDemoSnapshot: ActiveDemoSnapshot | null = null;

export class DemoWorldSeedRefusedError extends Error {
    readonly code = 'demo_credentials_present';

    constructor() {
        super('Demo mode seeding refused because stored credentials are present.');
        this.name = 'DemoWorldSeedRefusedError';
    }
}

export class DemoWorldRuntimeResidueError extends Error {
    readonly code = 'demo_runtime_residue';

    constructor(readonly findings: readonly DemoRuntimeResidueFinding[]) {
        super(`Demo mode teardown found runtime residue after clearing the seeded world: ${JSON.stringify(findings)}`);
        this.name = 'DemoWorldRuntimeResidueError';
    }
}

export type DemoWorldResiduePolicy = 'strict' | 'diagnostic';

export type SeedDemoWorldOptions = Readonly<{
    residuePolicy?: DemoWorldResiduePolicy;
}>;

export type ClearDemoWorldOptions = Readonly<{
    residuePolicy?: DemoWorldResiduePolicy;
}>;

/**
 * One mode decision, made at seed time and threaded to BOTH tracker
 * installation and teardown. The strict test-harness contract keeps full
 * attribution; the live product path (`diagnostic`) installs the cheap
 * counting-only tracker so the pre-auth journey pays no per-timer stack cost.
 */
function residueModeForPolicy(policy: DemoWorldResiduePolicy): DemoRuntimeResidueMode {
    return policy === 'diagnostic' ? 'runtime' : 'strict';
}

export type ClearDemoWorldResult = Readonly<{
    residueFindings: readonly DemoRuntimeResidueFinding[];
}>;

function reportRuntimeResidue(findings: readonly DemoRuntimeResidueFinding[]): void {
    if (typeof __DEV__ === 'undefined' || __DEV__ !== true) return;
    console.warn('[DemoMode] Runtime teardown found residue; continuing after restoring the real world.', {
        code: 'demo_runtime_residue',
        findings,
    });
}

function collectWorldIds(world: DemoWorld): Pick<ActiveDemoSnapshot, 'sessionIds' | 'machineIds'> {
    return {
        sessionIds: new Set(world.sessions.map((session) => session.id)),
        machineIds: new Set(world.machines.map((machine) => machine.id)),
    };
}

export async function seedDemoWorld(options: SeedDemoWorldOptions = {}): Promise<DemoWorld> {
    const residuePolicy: DemoWorldResiduePolicy = options.residuePolicy ?? 'strict';

    if (activeDemoSnapshot) {
        return buildDemoWorld();
    }

    const credentials = await TokenStorage.getCredentials();
    if (credentials) {
        throw new DemoWorldSeedRefusedError();
    }

    const world = buildDemoWorld();
    const ids = collectWorldIds(world);
    const activeServerSnapshot = getActiveServerSnapshot();
    const demoServerProfileExisted = listServerProfiles().some((profile) => profile.serverUrl === DEMO_SERVER_BASE_URL);
    const demoServerProfile = upsertAndActivateServer({
        serverUrl: DEMO_SERVER_BASE_URL,
        name: 'Demo Relay',
        source: 'preconfigured',
        scope: 'device',
    });
    const primedServerFeatureIds = Array.from(new Set([
        demoServerProfile.id,
        getActiveServerSnapshot().serverId,
        ...listServerProfileScopeIds(listServerProfiles()),
    ].filter(Boolean)));
    activeDemoSnapshot = {
        snapshot: takeStoreSnapshot(storage.getState()),
        ...ids,
        activeServerSnapshot,
        demoServerProfileId: demoServerProfile.id,
        demoServerProfileExisted,
        primedServerFeatureIds,
        residuePolicy,
    };

    enterDemoMode();
    for (const serverId of primedServerFeatureIds) {
        primeServerFeaturesSnapshot({
            serverId,
            snapshot: { status: 'ready', features: world.serverFeatures },
        });
    }

    // Demo settings are presentation-only. Applying them through
    // `applySettingsLocal`, `applyLocalSettings`, or `applyProfile` would write
    // the temporary demo target, UI choices, theme profiles, and connected
    // accounts to durable MMKV, while teardown restores only the in-memory
    // snapshot. Project every seeded slice directly into the demo-owned store
    // lifetime, just like the non-persisted review drafts below.
    storage.setState((current) => ({
        ...current,
        settings: {
            ...current.settings,
            ...world.settings,
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: demoServerProfile.id,
        },
        localSettings: {
            ...current.localSettings,
            ...world.localSettings,
        },
        profile: {
            ...current.profile,
            ...world.profile,
        },
    }));
    const state = storage.getState();
    state.applyMachines(world.machines);
    state.applySessions(world.sessions);

    for (const [sessionId, messages] of Object.entries(world.messages)) {
        state.applyMessages(sessionId, messages);
        state.applyMessagesLoaded(sessionId);
    }
    for (const [sessionId, pending] of Object.entries(world.pending)) {
        state.applyPendingMessages(sessionId, pending.messages);
    }
    // Seed review drafts by writing the store slice directly: the canonical
    // `upsertSessionReviewCommentDraft` action persists to durable storage on every
    // write, and demo-world content must never reach persistence (a hard exit
    // mid-journey would otherwise leave demo drafts in the real profile forever —
    // teardown only restores the in-memory slice).
    if (Object.keys(world.reviewComments).length > 0) {
        storage.setState((current) => ({
            ...current,
            reviewCommentsDraftsBySessionId: {
                ...current.reviewCommentsDraftsBySessionId,
                ...Object.fromEntries(
                    Object.entries(world.reviewComments).map(([sessionId, drafts]) => [sessionId, [...drafts]]),
                ),
            },
        }));
    }
    state.applyReady();

    startDemoRuntimeResidueTracking(residueModeForPolicy(residuePolicy));

    return world;
}

export async function clearDemoWorld(options: ClearDemoWorldOptions = {}): Promise<ClearDemoWorldResult> {
    const active = activeDemoSnapshot;
    if (!active) {
        if (isDemoModeActive()) exitDemoMode();
        return { residueFindings: [] };
    }

    storage.setState((current) => buildStoreStateAfterDemoRestore({
        current,
        snapshot: active.snapshot,
        sessionIds: active.sessionIds,
        machineIds: active.machineIds,
    }));
    setActiveServer({ serverId: active.activeServerSnapshot.serverId, scope: 'device' });
    for (const serverId of active.primedServerFeatureIds) {
        deleteServerFeaturesSnapshot({ serverId });
    }
    if (
        !active.demoServerProfileExisted
        && listServerProfiles().some((profile) => profile.id === active.demoServerProfileId)
    ) {
        removeServerProfile(active.demoServerProfileId);
    }
    // The residue policy is one decision, fixed at seed time. Teardown honors
    // the seeded policy unless a caller explicitly overrides it, so a
    // runtime-seeded (diagnostic) journey can never be stranded by the strict
    // throw path, and a strict-seeded harness keeps its zero-residue gate.
    const residuePolicy = options.residuePolicy ?? active.residuePolicy;
    const residueFindings = stopDemoRuntimeResidueTracking();
    activeDemoSnapshot = null;
    if (isDemoModeActive()) exitDemoMode();
    if (residueFindings.length > 0) {
        if (residuePolicy !== 'diagnostic') {
            throw new DemoWorldRuntimeResidueError(residueFindings);
        }
        reportRuntimeResidue(residueFindings);
    }
    return { residueFindings };
}

export function resetDemoWorldSeedStateForTests(): void {
    activeDemoSnapshot = null;
}
