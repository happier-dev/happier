/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { PluginDeclarativeDocumentV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/declarative-document-authoring';
import { freezePluginDeclarativeDataNodeV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDataV1';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

// Real browser presentation and event composition; only native adapters and Home IO are replaced.
vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsRealModule());
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { KeyboardAvoidingView: View };
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await loadSyncSingletonForTests();
const { View } = await import('react-native');
const { WidgetFlowShell } = await import('../flow/WidgetFlowShell');
const { WidgetSnapshotConfirmPanel } = await import('./WidgetSnapshotConfirmPanel');
const { createWidgetSnapshotCaptureSlot } = await import('./widgetSnapshotCapture');
const { ModalProvider } = await import('@/modal/ModalProvider');
await import('@/sync/ops/actions/defaultActionExecutor');

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('publishes the frozen preview when the desktop popover primary receives a pointer click', async () => {
    await harness.reset();
    const accountId = 'snapshot-pointer-owner';
    const sessionId = 'snapshot-pointer-session';
    const boardPath = `/v2/sessions/${sessionId}/board`;
    const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const serverId = await harness.addHome({ name: 'Snapshot Home', serverUrl: 'https://snapshot-pointer.example', accountId });
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Expected sessions.board feature');
    harness.answer(serverId, '/v1/features', { body: features });
    harness.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    harness.answer(serverId, '/v1/auth/ping', { body: { success: true } });
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
        mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
    } });
    const sessionDetail = { session: {
        id: sessionId, createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 4,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: { path: '/work/project', machineId: 'machine' }, agentState: null })),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({
            v: 1, workspace: { path: '/work/project', machineId: 'machine' },
        })),
        agentStateVersion: 5, agentState: null, share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }) },
        responsibleAccountId: null, responsibleAccount: null,
    } };
    harness.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { body: sessionDetail });
    harness.answer(serverId, 'POST /v2/sessions/read-batch', { body: SessionReadBatchResponseV1Schema.parse({
        results: [{ sessionId, detail: { status: 200, body: sessionDetail } }],
    }) });
    harness.answer(serverId, `GET /v2/sessions/${sessionId}/system-records/record`, { body: { record: null } });
    harness.answer(serverId, `/v2/sessions/${sessionId}/system-records/record?owner=host&namespace=surface&kind=layout.v1&localId=layout`, {
        body: { record: {
            id: 'snapshot-layout', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
            content: { t: 'plain', v: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] } },
            revision, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
        } },
    });
    harness.answer(serverId, `PUT ${boardPath}`, { select: input => ({ body: {
        operation: 'upsert_item', itemId: Reflect.get(input as object, 'itemId'), outcome: 'created', itemRevision: revision, layoutRevision: revision,
    } }) });
    await harness.requireUiApproval(serverId, []);

    const documentSource = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: {
        kind: 'metric', label: 'Checks',
        data: { kind: 'resource', resource: { pluginId: 'acme.checks', localId: 'summary' },
            inputSchema: { type: 'object', additionalProperties: false },
            outputSchema: { type: 'object', properties: { passed: { type: 'number' } } } },
        value: { path: ['passed'], type: 'number' },
    } });
    if (documentSource.root.kind !== 'metric') throw new Error('Expected metric');
    const metric = documentSource.root;
    let shown = 7;
    const slot = createWidgetSnapshotCaptureSlot();
    const unregister = slot.register({ read: () => ({ document: documentSource, current: true, readIdentity: 'checks', readAuthorized: true,
        digests: ['source-7'], refresh: async () => {},
        frozenByPath: new Map([['root', freezePluginDeclarativeDataNodeV1(metric, { passed: shown, secret: 'private-unselected' })]]),
    }), subscribe: () => () => {} });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const done = vi.fn();
    const cancel = vi.fn();
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    function Confirm() {
        const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
        return <><View ref={anchor} testID="snapshot-anchor" />
            <WidgetFlowShell anchorRef={anchor} title="Post a snapshot" onRequestClose={cancel} testID="snapshot-flow">
                <WidgetSnapshotConfirmPanel surface={{ serverId, accountId, owner: { kind: 'sessionBoard', sessionId } }}
                    title="Checks" sourceLabel="Checks summary" capture={slot.capture} watch={slot.watch}
                    onDone={done} onCancel={cancel} testID="snapshot-pointer" />
            </WidgetFlowShell></>;
    }
    try {
        await act(async () => root.render(<ModalProvider><Confirm /></ModalProvider>));
        const primary = document.querySelector<HTMLElement>('[data-testid="snapshot-pointer.primary"]');
        expect(primary).not.toBeNull();
        expect(container.contains(primary)).toBe(false); // Real desktop portal, rather than an inline shell mock.
        expect(primary!.closest('[inert], [aria-hidden="true"]')).toBeNull();
        expect(primary!.getAttribute('aria-disabled')).not.toBe('true');
        const openDialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
        shown = 99;
        await act(async () => {
            primary!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
            primary!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
            primary!.focus();
            primary!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
            primary!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
            primary!.click();
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(done).toHaveBeenCalledOnce();
        });
        // The existing desktop flow itself is a dialog; Post must not open another one.
        expect(Array.from(document.querySelectorAll('[role="dialog"]'))).toEqual(openDialogs);
        expect(cancel).not.toHaveBeenCalled();
        const writes = harness.requestsFor(boardPath);
        expect(writes).toHaveLength(1);
        expect(writes[0]?.input).toMatchObject({ operation: 'upsert_item', itemContent: { t: 'plain', v: {
            source: { kind: 'declarative', document: { root: { data: { kind: 'value', value: 7 } } } },
            snapshot: { provenance: [{ label: 'Checks summary', digest: 'source-7' }] },
        } } });
        expect(JSON.stringify(writes[0]?.input)).not.toContain('private-unselected');
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore(); unregister(); container.remove(); standardCleanup();
    }
});
