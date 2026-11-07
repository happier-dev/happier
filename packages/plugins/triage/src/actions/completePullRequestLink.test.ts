import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { getActionSpec } from '@happier-dev/plugin-sdk/actions';
import { SessionPullRequestLinkCompletionResultV1Schema } from '@happier-dev/channels-protocol/v1';

import { TRIAGE_PLUGIN } from '../manifest.js';

const session = { serverId: 'home-original', sessionId: 'session-linked' };
const surface = { ...session, accountId: 'account-original', owner: { kind: 'companion', sessionId: session.sessionId } };
const widgetSurface = { serverId: surface.serverId, accountId: surface.accountId, owner: surface.owner };
const definition = { kind: 'installed', surface: { pluginId: 'happier.triage', localId: 'session-pull-request' } } as const;

describe('registered daemon PR-link completion', () => {
    it.each(['available', 'manual', 'no-client', 'ambiguous', 'approval', 'profile-approval', 'add-approval', 'uncertain', 'foreign', 'foreign-add'] as const)(
        'places only through the original bound Account Widget receiver: %s', async mode => {
        const calls: unknown[] = [];
        let instances: unknown[] = mode === 'manual' ? [{ instance: { v: 1, id: 'person-added', definition,
            bindings: { session: { kind: 'value', value: session } } } }] : [];
        const actions: PluginServices['actions'] = {
            // Host Actions are the real remote boundary. Canonical schema admission and Triage's handler stay real.
            async execute(action, input) {
                calls.push({ action, input });
                if (action === 'account.profile.get') return (mode === 'profile-approval'
                    ? { kind: 'approval_request_created', artifactId: 'approval-profile', actionId: action }
                    : { id: 'account-original', timestamp: 1, name: null,
                        firstName: null, lastName: null, username: null, avatar: null }) as never;
                if (mode === 'approval') return { kind: 'approval_request_created', artifactId: 'approval-1', actionId: String(action) } as never;
                const answeredSurface = mode === 'foreign' || (mode === 'foreign-add' && action === 'widgets.item.add')
                    ? { ...widgetSurface, accountId: 'account-new-viewer' } : widgetSurface;
                if (action === 'widgets.catalog.list') return getActionSpec(action).outputSchema.parse({ surface: answeredSurface,
                    entries: mode === 'no-client' ? [] : Array.from({ length: mode === 'ambiguous' ? 2 : 1 }, () => ({ definition, availability: 'available', title: 'Pull request', fields: [],
                        instanceCount: instances.length, sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
                        presentation: { sizes: ['medium'], defaultSize: 'medium' } })),
                    presentation: { sizes: ['medium'], defaultSize: 'medium' } }) as never;
                if (action === 'widgets.item.list') return getActionSpec(action).outputSchema.parse({
                    surface: answeredSurface, canEdit: true, instances }) as never;
                if (action === 'widgets.item.add') {
                    if (mode === 'add-approval') return { kind: 'approval_request_created', artifactId: 'approval-add', actionId: action } as never;
                    const admitted = getActionSpec(action).inputSchema.parse(input);
                    if (!admitted || typeof admitted !== 'object' || !('instance' in admitted)) throw new Error('Expected admitted Widget add');
                    instances = [{ instance: admitted.instance }];
                    if (mode === 'uncertain') throw new Error('Widget add response lost');
                    return getActionSpec(action).outputSchema.parse({ ref: { surface: answeredSurface,
                        instanceId: 'happier.triage:session-pull-request' }, instance: admitted.instance }) as never;
                }
                throw new Error(`Unexpected host Action ${String(action)}`);
            },
            executeAdmittedTargetedOperation: async () => { throw new Error('No other contribution read'); },
            observe: async () => { throw new Error('No observer'); },
            observeAdmittedTargetedOperation: async () => { throw new Error('No observer'); },
            executeWithExecutionOrigin: async () => { throw new Error('No other contribution read'); },
            executeAdmittedTargetedOperationWithExecutionOrigin: async () => { throw new Error('No other contribution read'); },
        };
        const plugin = await createPluginTestkit({ manifest: TRIAGE_PLUGIN.manifest, module: TRIAGE_PLUGIN,
            services: { actions } });
        try {
            const result = SessionPullRequestLinkCompletionResultV1Schema.parse(await plugin.invokeAction(
                'sessions/complete-pull-request-link-v1', { v: 1, session }, { surface: 'plugin' }));
            expect(result).toEqual({ kind: mode === 'available' ? 'added' : mode === 'manual' ? 'present' : 'unavailable' });
            expect(calls[0]).toEqual({ action: 'account.profile.get', input: {} });
            const adds = calls.filter(call => typeof call === 'object' && call !== null && 'action' in call && call.action === 'widgets.item.add');
            expect(adds).toHaveLength(['available', 'foreign-add', 'uncertain', 'add-approval'].includes(mode) ? 1 : 0);
            if (mode === 'available') expect(adds[0]).toMatchObject({ input: { surface: widgetSurface,
                instance: { bindings: { session: { kind: 'value', value: session } } } } });
            if (mode === 'available') expect(SessionPullRequestLinkCompletionResultV1Schema.parse(await plugin.invokeAction(
                'sessions/complete-pull-request-link-v1', { v: 1, session }, { surface: 'plugin' }))).toEqual({ kind: 'present' });
        } finally { await plugin.dispose(); }
    });
});
