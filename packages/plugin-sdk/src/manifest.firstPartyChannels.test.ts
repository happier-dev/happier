import { beforeAll, describe, expect, it } from 'vitest';

import { parsePluginManifest } from './manifest.js';
import { PluginActionContributionV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { createPluginActionPresentUserGate } from '@happier-dev/protocol/plugins/actions/invocation';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { CONVERSATION_MANAGEMENT_ACTION_IDS_V1 } from '@happier-dev/channels-protocol/v1';
import { definePlugin } from './definePlugin.js';

async function loadSourceManifest(packageName: string): Promise<unknown> {
    // The source module is the real manifest producer, loaded at the filesystem boundary.
    const source: { PLUGIN_MANIFEST: unknown } = await import(
        `../../plugins/${packageName}/src/manifest.ts`
    );
    return source.PLUGIN_MANIFEST;
}

describe('first-party channel manifest admission', () => {
    let channelsManifest: unknown;
    beforeAll(async () => { channelsManifest = await loadSourceManifest('channels'); });

    it.each([
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete,
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete,
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamNoticeDismiss,
    ])('%s respects shared Action waivers, Ask and decline', async (actionId) => {
        const parsed = parsePluginManifest(channelsManifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const action = PluginActionContributionV2Schema.parse(parsed.manifest.contributes.actions?.find(
            candidate => candidate.id === actionId,
        ));
        const qualifiedId = `happier.channels/actions/${actionId}` as const;
        for (const mode of ['waiver', 'ask', 'decline'] as const) {
            const settings = normalizeActionsSettingsV1(mode === 'waiver'
                ? { v: 1, approvalWaivedSurfaces: { [qualifiedId]: ['ui'] } }
                : mode === 'ask'
                    ? { v: 1, actions: { [qualifiedId]: { approvalRequiredSurfaces: ['ui'] } } }
                    : { v: 1 });
            const prompts: string[] = [];
            const gate = createPluginActionPresentUserGate({
                resolve: () => ({
                    status: 'resolved', action,
                    policy: {
                        ...action, qualifiedId, occurrenceId: 'channels-current',
                        availability: { status: 'visible', code: 'plugin_action_available' },
                        approvalRequiredByActionSettings: isApprovalRequiredByActionsSettings(
                            qualifiedId, settings, { surface: 'ui' }, undefined, true,
                        ),
                        authorization: {
                            generation: { targetGeneration: 'current', desiredGeneration: 'current', appliedGeneration: 'current' },
                            resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [],
                        },
                    },
                }),
                requestCurrentIntent: async request => {
                    prompts.push(request.action.id);
                    return mode === 'decline'
                        ? { status: 'rejected', code: 'plugin_action_current_intent_rejected' }
                        : { status: 'approved', fingerprint: request.fingerprint };
                },
            });
            const result = await gate.admit({
                input: { connectionId: 'connection-1', bindingId: 'binding-1', expectedRevision: 1 },
                surface: 'ui', invocationSurface: 'ui',
            });
            expect(prompts).toEqual(mode === 'waiver' ? [] : [actionId]);
            expect(result).toMatchObject(mode === 'decline'
                ? { status: 'unavailable', code: 'plugin_action_current_intent_rejected' }
                : { status: 'admitted', action });
        }
    });

    it.each(['channels', 'external'])('uses input-sensitive confirmation defaults for %s declarations', async (source) => {
        const manifest = source === 'channels' ? channelsManifest : definePlugin({
            id: 'example.bindings', displayName: 'Bindings', version: '1.0.0',
            actions: {
                manage: {
                    title: 'Manage bindings', surfaces: ['cli', 'agent', 'mcp'],
                    dangerLevel: 'writesLocal', confirmation: { title: 'Change bindings?' },
                    confirmationWhen: { op: 'not', predicate: { op: 'eq', path: 'kind', value: 'list' } },
                    run: async () => null,
                },
            },
        }).manifest;
        const parsed = parsePluginManifest(manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const action = PluginActionContributionV2Schema.parse(parsed.manifest.contributes.actions?.find(
            candidate => candidate.id === (source === 'channels' ? 'session-pull-request-binding-v1' : 'manage'),
        ));
        const admit = (kind: string, approvalRequiredByActionSettings?: boolean, surface = 'cli') => createPluginActionPresentUserGate({
            resolve: () => ({
                status: 'resolved', action,
                policy: {
                    ...action, qualifiedId: `${parsed.manifest.id}/${action.id}`, occurrenceId: 'current',
                    // The host boundary publishes evaluated availability, not the manifest predicate.
                    availability: { status: 'visible', code: 'plugin_action_available' },
                    ...(approvalRequiredByActionSettings === undefined ? {} : { approvalRequiredByActionSettings }),
                    authorization: {
                        generation: { targetGeneration: 'current', desiredGeneration: 'current', appliedGeneration: 'current' },
                        resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [],
                    },
                },
            }),
        }).admit({ input: { kind, sessionId: 'session-1' }, surface, invocationSurface: surface });

        for (const surface of ['cli', 'agent', 'mcp']) {
            expect(await admit('list', undefined, surface)).toMatchObject({ status: 'admitted' });
            expect(await admit('attach', undefined, surface)).toMatchObject(source === 'channels' && surface === 'cli'
                ? { status: 'admitted' }
                : { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
            expect(await admit('removeTrigger', undefined, surface)).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
        }
        expect(await admit('list', true)).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
        expect(await admit('attach', true)).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
        expect(await admit('removeTrigger')).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
        expect(await admit('attach', false)).toMatchObject({ status: 'admitted' });
    });

    it.each(['channel-email', 'channel-telegram', 'channel-discord', 'scm-github'])(
        'admits the real %s source manifest through the public parser',
        async (packageName) => {
            const parsed = parsePluginManifest(await loadSourceManifest(packageName));
            expect(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toBe(true);
        },
    );

    it('rejects a malformed service arm in a real credential-select declaration', async () => {
        const parsed = parsePluginManifest(await loadSourceManifest('channel-telegram'));
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const actions = parsed.manifest.contributes.actions ?? [];
        const action = actions.find((candidate) => (
            candidate.inputSchema?.properties?.credentialRef?.properties?.service !== undefined
        ));
        const credentialRef = action?.inputSchema?.properties?.credentialRef;
        const service = credentialRef?.properties?.service;
        if (!action || !credentialRef || !service) throw new Error('Expected the real account-select declaration');
        const malformed = parsePluginManifest({
            ...parsed.manifest,
            contributes: {
                ...parsed.manifest.contributes,
                actions: actions.map((candidate) => candidate !== action ? candidate : {
                    ...action,
                    inputSchema: {
                        ...action.inputSchema,
                        properties: {
                            ...action.inputSchema?.properties,
                            credentialRef: {
                                ...credentialRef,
                                properties: {
                                    ...credentialRef.properties,
                                    service: { anyOf: [service, { type: 'string' }] },
                                },
                            },
                        },
                    },
                }),
            },
        });
        expect(malformed.ok).toBe(false);
        if (malformed.ok) throw new Error('Malformed account selection was admitted');
        expect(malformed.diagnostics.some((diagnostic) => diagnostic.path?.includes('connectedAccountPurposeBindings') === true)).toBe(true);
        expect(malformed.diagnostics.some((diagnostic) => diagnostic.path?.includes('widget') === true)).toBe(true);
    });
});
