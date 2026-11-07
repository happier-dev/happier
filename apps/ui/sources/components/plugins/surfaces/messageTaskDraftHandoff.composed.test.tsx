// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import type { PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { createPluginRegistrationScope } from '@/sync/domains/plugins/registrationScope';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { derivePluginClientContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { MessageActionAvailableSnapshotV1Schema } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';
import { activate } from '@happier-dev/plugins-triage/happier-plugin-ui/triage-mounted-ui-action-native';
import { renderSurface } from '@happier-dev/plugins-triage/happier-plugin-ui/triage-tasks-page-native';

import { renderScreen } from '@/dev/testkit';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getPluginUiEphemeralSharedScope, usePluginUiEphemeralSharedScopeBinding } from './pluginUiEphemeralSharedScope';

describe('message Action → Tasks draft through the host shared scope', () => {
    it('keeps the selected message through a committed destination scope rebind until the person closes it', async () => {
        const retirement = new AbortController();
        const accountLifetime: ActiveServerAccountScopeLifetime = {
            scope: { serverId: 'home', accountId: 'account' },
            isCurrent: () => !retirement.signal.aborted,
            onRetire: listener => {
                retirement.signal.addEventListener('abort', listener);
                return { dispose: () => retirement.signal.removeEventListener('abort', listener) };
            },
        };
        const occurrenceId = 'message-task-occurrence';
        const actionScope = getPluginUiEphemeralSharedScope({ accountLifetime,
            pluginId: PLUGIN_MANIFEST.id, occurrenceId, isCurrent: () => true });
        const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'tasks/open-create-v1');
        if (declaration?.execution.target !== 'client') throw new Error('Missing Tasks client Action');
        const target = { ...declaration.execution.client, platform: 'web' as const };
        const registrations = createPluginRegistrationScope({ pluginId: PLUGIN_MANIFEST.id,
            target: { realm: 'client', ...target },
            rights: derivePluginClientContributionRegistrationRights(PLUGIN_MANIFEST.contributes, target) });
        activate(registrations.api);
        const action = registrations.commit().find(entry => entry.family === 'actions' && entry.localId === declaration.id);
        if (action?.family !== 'actions') throw new Error('Missing registered Action');
        // Registration captures are opaque at the host boundary; the declared realm is client.
        const handler = action.value as PluginClientActionHandler;
        let launchInput: unknown;
        const fixture = await createPluginUiTestkit({ identity: { instanceId: 'message-launch', mountNonce: 'launch' },
            authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
            surface: defineUiSurface(() => null), surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {
                openSurface: ({ input }) => { launchInput = input; },
                // Genuine remote Account/daemon transport boundary; opening a draft must work before these reads recover.
                executeAction: () => { throw new Error('Account transport unavailable'); },
            } });
        let mounted: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const lifetimes = [{ isCurrent: () => true }, { isCurrent: () => true }];
        function Destination({ binding }: Readonly<{ binding: number }>) {
            const shared = usePluginUiEphemeralSharedScopeBinding({ accountLifetime,
                pluginId: PLUGIN_MANIFEST.id, occurrenceId, mountLifetime: lifetimes[binding]! });
            const node = renderSurface({ ...fixture.context, launchInput });
            if (!React.isValidElement(node)) throw new Error('Expected a provider surface');
            // The physical host attaches private bindings to the public surface's returned provider.
            return React.cloneElement(node as React.ReactElement<{ ephemeralSharedScope: PluginEphemeralSharedScope | null }>,
                { ephemeralSharedScope: shared });
        }
        try {
            await expect(handler({}, {
                plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
                invocationSurface: 'agent', signal: new AbortController().signal,
                ui: fixture.context.hostApi, ephemeralSharedScope: actionScope,
                messageAction: MessageActionAvailableSnapshotV1Schema.parse({ sessionId: 'session', messageId: 'message',
                    observedRevision: 'revision', role: 'agent', contentCategory: 'text', seq: 1,
                    visibleText: 'A selected message\nwith its complete draft', structuredPresentationSummary: null,
                    provenanceCategory: 'owner' }),
            })).resolves.toEqual({ status: 'applied' });
            mounted = await renderScreen(<Destination binding={0} />);
            expect(mounted.getTextContent()).toContain('Where does it belong?');
            await mounted.update(<Destination binding={1} />);
            expect(mounted.getTextContent()).toContain('Where does it belong?');
            expect(mounted.getTextContent()).not.toContain('This task draft is no longer available');
            const close = mounted.findAll(node => node.props.testID === 'triage-shell-detail-region:back'
                && typeof node.props.onPress === 'function')[0];
            expect(close).toBeDefined();
            await act(async () => { close!.props.onPress(); });
            expect(mounted.getTextContent()).not.toContain('Where does it belong?');
            await mounted.update(<Destination binding={0} />);
            expect(mounted.getTextContent()).not.toContain('This task draft is no longer available');
            await mounted.unmount();
            mounted = await renderScreen(<Destination binding={0} />);
            // A later open of the already-canceled address cannot recover its text.
            expect(mounted.getTextContent()).toContain('This task draft is no longer available');
        } finally {
            await mounted?.unmount();
            await fixture.dispose();
            retirement.abort();
        }
    });
});
