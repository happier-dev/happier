import {
    AccountProfileSchema,
    isConnectedServiceCredentialHealthStatusUsable,
    readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
    readServerEnabledBit,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { profileDefaults } from '@/sync/domains/profiles/profile';
import { coerceExecutionRunsGuidanceEntries } from '@/sync/domains/settings/executionRunsGuidance';
import { readSessionWorkspaceContext } from '@/sync/domains/session/readSessionWorkspaceContext';
import { ThemeProfilesLocalStateSchema } from '@/theme/profiles/themeProfilePersistence';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/runtimePresentation';
import { getSessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import {
    buildDemoWorld,
    createDemoExternalSessionBrowseCandidateFixture,
    DEMO_RICH_SESSION_ID,
} from './buildDemoWorld';
import {
    DEMO_MACHINE_ID,
    DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
    DEMO_PROJECT_PATH,
    DEMO_REVIEW_SESSION_ID,
} from './constants';

describe('buildDemoWorld', () => {
    it('builds the canonical production-safe demo world', () => {
        const world = buildDemoWorld();
        const richSession = world.sessions.find((session) => session.id === DEMO_RICH_SESSION_ID);

        expect(world.sessions.length).toBeGreaterThanOrEqual(9);
        expect(world.machines.length).toBeGreaterThanOrEqual(2);
        expect(richSession?.encryptionMode).toBe('plain');
        expect(richSession?.metadata?.sessionModelsV1).toMatchObject({
            agentId: 'opencode',
            currentModelId: expect.any(String),
            availableModels: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
        });
        expect(richSession?.metadata?.sessionConfigOptionsV1).toMatchObject({
            agentId: 'opencode',
            configOptions: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
        });
        expect(getSessionStorageKind(richSession)).toBe('direct');
        expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata(richSession?.metadata)).toMatchObject({
            v: 1,
            agentId: 'opencode',
            machineId: DEMO_MACHINE_ID,
            remoteSessionId: DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
            source: {
                kind: 'opencodeServer',
                directory: DEMO_PROJECT_PATH,
            },
            qualifiedIdentity: {
                v: 1,
                agent: {
                    pluginId: 'happier.agent.opencode',
                    localId: 'opencode',
                },
                source: {
                    kind: 'opencodeServer',
                    contractVersion: 1,
                },
            },
        });
        expect(richSession?.metadata?.directSessionV1).toMatchObject({
            v: 1,
            providerId: 'opencode',
            machineId: DEMO_MACHINE_ID,
            remoteSessionId: DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
        });
        expect(richSession?.metadata?.directSessionV1).not.toHaveProperty('qualifiedIdentity');
        expect(richSession?.metadata?.directSessionV1).not.toHaveProperty('linkData');

        const browseCandidate = createDemoExternalSessionBrowseCandidateFixture();
        expect(browseCandidate).toMatchObject({
            remoteSessionId: DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
            details: {
                machineId: DEMO_MACHINE_ID,
                path: DEMO_PROJECT_PATH,
                source: {
                    kind: 'opencodeServer',
                    directory: DEMO_PROJECT_PATH,
                },
            },
        });
        const richMessages = world.messages[DEMO_RICH_SESSION_ID] ?? [];
        expect(richMessages.length).toBeGreaterThanOrEqual(8);
        expect(richMessages.some((message) =>
            message.role === 'agent' && message.content.some((content) => content.type === 'tool-call')
        )).toBe(true);
        const transcriptText = richMessages
            .flatMap((message) => Array.isArray(message.content)
                ? message.content.map((content) => content.type === 'text' ? content.text : '')
                : [message.content.type === 'text' ? message.content.text : ''])
            .join('\n');
        expect(transcriptText).toContain('```tsx');
        expect(transcriptText).toContain('+');
        expect(transcriptText).toContain('-');

        const workingSessions = world.sessions.filter((session) => session.active || session.thinking);
        const visiblyWorkingSessions = world.sessions.filter((session) => (
            deriveSessionRuntimePresentationState({ ...session, nowMs: Date.now() }).working
        ));
        const needsAttentionSessions = world.sessions.filter((session) => (session.pendingBlockedCount ?? 0) > 0);
        expect(workingSessions.length).toBeGreaterThanOrEqual(2);
        expect(workingSessions.length).toBeLessThanOrEqual(3);
        expect(visiblyWorkingSessions.length).toBeGreaterThanOrEqual(2);
        expect(visiblyWorkingSessions.length).toBeLessThanOrEqual(3);
        expect(needsAttentionSessions.length).toBeGreaterThanOrEqual(2);
        expect(needsAttentionSessions.length).toBeLessThanOrEqual(3);
        expect(richSession).toMatchObject({
            lastViewedSessionSeq: richSession?.seq,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 1,
        });
        expect(richSession?.metadata?.readStateV1).toMatchObject({
            sessionSeq: richSession?.seq,
            pendingActivityAt: expect.any(Number),
        });
        expect(richSession?.metadata).not.toHaveProperty('machineId');
        expect(world.pending[DEMO_RICH_SESSION_ID]?.messages).toHaveLength(1);
        expect(world.pending[DEMO_RICH_SESSION_ID]?.messages[0]).toMatchObject({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingDeliveryStatus: 'server_queued',
        });
        expect(world.reviewComments[DEMO_RICH_SESSION_ID]?.[0]).toMatchObject({
            source: 'diff',
            includeInPrompt: true,
        });
        expect(world.serverFeatures.features.sessions.folders.enabled).toBe(false);
        // A12 subscriptions/accounts beat: connected services enabled so the real
        // screen shows the service catalog + pools instead of the disabled stub.
        expect(world.serverFeatures.features.connectedServices.enabled).toBe(true);
        expect(readServerEnabledBit(world.serverFeatures, 'connectedServices.accountGroups')).toBe(true);

        // A8 review beat: a distinct seeded review session with a diff transcript
        // and two line-anchored review comment drafts (the diff-and-notes loop).
        const reviewMessages = world.messages[DEMO_REVIEW_SESSION_ID] ?? [];
        expect(reviewMessages.length).toBeGreaterThanOrEqual(3);
        expect(reviewMessages.some((message) =>
            message.role === 'agent' && message.content.some((content) => content.type === 'tool-call')
        )).toBe(true);
        expect(world.reviewComments[DEMO_REVIEW_SESSION_ID]).toHaveLength(2);
        expect(world.reviewComments[DEMO_REVIEW_SESSION_ID]?.[0]).toMatchObject({
            source: 'diff',
            includeInPrompt: true,
        });
        expect(world.settings).toMatchObject({
            featureToggles: {
                'execution.runs': true,
                'sessions.direct': true,
            },
            hideInactiveSessions: false,
            sessionListAttentionPromotionModeV1: 'global',
            sessionListWorkingPlacementModeV1: 'global',
            sessionListDensity: 'narrow',
            sessionListSectionModeV1: 'single',
        });

        for (const session of world.sessions) {
            expect(session.encryptionMode).toBe('plain');
            expect(session.metadata).not.toHaveProperty('workspacePath');
            expect(readSessionWorkspaceContext({ sessions: { [session.id]: session } }, session.id).workspacePath)
                .toBe(session.id === DEMO_RICH_SESSION_ID ? DEMO_PROJECT_PATH : null);
        }
        for (const machine of world.machines) {
            expect(machine.active).toBe(false);
            expect(machine.metadata).not.toHaveProperty('workspacePath');
        }
    });

    it('seeds every feature the dream beats claim on their own stage', () => {
        const world = buildDemoWorld();

        // A5 "One session. A whole team of agents." — the sub-agent screen renders
        // the disabled stub unless the execution-runs substrate is on AND guidance
        // rules exist, so the seed owns both.
        expect(world.settings.executionRunsGuidanceEnabled).toBe(true);
        const guidanceEntries = coerceExecutionRunsGuidanceEntries(world.settings.executionRunsGuidanceEntries);
        expect(guidanceEntries.length).toBeGreaterThanOrEqual(3);
        for (const entry of guidanceEntries) {
            expect(entry.enabled).not.toBe(false);
            expect(entry.title?.trim()).toBeTruthy();
            expect(entry.suggestedBackendTarget?.backendId).toBeTruthy();
        }

        // A12 "Pool your accounts." — connected accounts plus at least one
        // multi-member pool, bound as an agent default so the screen shows the
        // pool rather than "No connected services yet".
        const connectedServices = world.profile.connectedServicesV2;
        expect(connectedServices.length).toBeGreaterThanOrEqual(2);
        for (const service of connectedServices) {
            expect(service.profiles.some((entry) =>
                isConnectedServiceCredentialHealthStatusUsable(entry.status))).toBe(true);
        }
        const pools = connectedServices.flatMap((service) => service.groups);
        expect(pools.length).toBeGreaterThanOrEqual(1);
        expect(pools.every((pool) => pool.memberProfileIds.length >= 2)).toBe(true);
        const agentBindings = world.settings.connectedServicesDefaultAuthByAgentIdV1.bindingsByAgentId;
        const boundSelections = Object.values(agentBindings)
            .flatMap((binding) => Object.values(binding.bindingsByServiceId));
        expect(boundSelections.some((selection) =>
            selection.source === 'connected' && selection.selection === 'group')).toBe(true);
        // Quota meters need an authenticated relay, so the pre-auth stage could only
        // render an empty "no usage data" card under a headline about usage.
        expect(readServerEnabledBit(world.serverFeatures, 'connectedServices.quotas')).toBe(false);

        // A13 "Configure (almost) everything." — custom theme profiles so the
        // customization stage is not an empty grey list.
        // Exact count: each demo theme is a clone of a named built-in preset, so a
        // preset that stops resolving must fail here instead of quietly shrinking
        // the customization stage back toward empty.
        const themeProfiles = world.localSettings.themeProfiles.profiles;
        expect(themeProfiles).toHaveLength(4);
        for (const profile of themeProfiles) {
            expect(profile.name.trim()).toBeTruthy();
            const overrideCount = Object.keys(profile.overrides.light).length
                + Object.keys(profile.overrides.dark).length;
            expect(overrideCount).toBeGreaterThan(0);
        }

        // A9 "Build it. Ship it." — the source-control stage reads as a configured
        // workspace instead of untouched defaults.
        expect(world.settings.scmCommitMessageGeneratorEnabled).toBe(true);
        expect(world.settings.scmCommitMessageGeneratorInstructions.trim()).toBeTruthy();
        expect(world.settings.scmIncludeCoAuthoredBy).toBe(true);
    });

    it('keeps the seeded account and theme state valid for the owners that re-parse it', () => {
        // The seed writes these slices straight into the store, so nothing parses
        // them on the way in — but both owners re-parse on their next real write or
        // load, and both drop invalid entries silently rather than failing. An
        // invalid demo shape would put A12/A13 back in their empty states.
        const world = buildDemoWorld();

        expect(AccountProfileSchema.parse({ ...profileDefaults, ...world.profile }).connectedServicesV2)
            .toEqual(world.profile.connectedServicesV2);
        // Identity only: the V1 trust-boundary sanitizer is written for imported
        // profiles and may normalize token values. What must hold is that no demo
        // profile is rejected outright.
        expect(ThemeProfilesLocalStateSchema.parse(world.localSettings.themeProfiles).profiles.map((p) => p.id))
            .toEqual(world.localSettings.themeProfiles.profiles.map((p) => p.id));
    });
});
