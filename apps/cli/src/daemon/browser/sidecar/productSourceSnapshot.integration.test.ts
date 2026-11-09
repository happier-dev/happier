import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type BrowserAutomationActionRequestV1 } from '@happier-dev/protocol';

// Only environment and the fixture HTTP page are substituted; Chromium/CDP and owners stay real.
const environment = vi.hoisted(() => ({ directory: '' }));
vi.mock('@/configuration', () => ({ configuration: {
    get happyHomeDir() { return environment.directory; },
    get logsDir() { return join(environment.directory, 'logs'); },
} }));

import { createProductBrowserSidecarControlAdapterFactory } from './productSource';
import { resolveManagedBrowserSidecarCandidate } from './source';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserContextRoutes } from '../context/routes';
import { createSidecarCdpBrowserContextSource } from '../context/cdp/productSource';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';

describe('installed managed browser snapshots', () => {
    it('returns ordinary and semantic snapshots while masking password and CSS-sensitive text', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-browser-snapshot-'));
        environment.directory = process.env.HAPPIER_TEST_BROWSER_RUNTIME_HOME ?? root;
        const server = createServer((_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><button id="public">Public snapshot content</button><input type="password" value="password-canary"><div style="-webkit-text-security:disc">css-canary</div>');
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Snapshot fixture did not bind');
        const profiles = createBrowserProfileStore({ storageRootDirectory: root,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
        let runtime: Awaited<ReturnType<ReturnType<typeof createProductBrowserSidecarControlAdapterFactory>>> | undefined;
        let service: ReturnType<typeof createBrowserAutomationDaemonService> | undefined;
        try {
            expect((await resolveManagedBrowserSidecarCandidate())?.available, 'A preinstalled pinned managed browser is required').toBe(true);
            runtime = await createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles })({ machineId: 'snapshot_machine' });
            if (!runtime.ok || !runtime.contextCapture) throw new Error('Managed browser runtime unavailable');
            const capture = runtime.contextCapture;
            const view = { browserSessionId: 'snapshot-session', viewId: 'snapshot-view' };
            expect(await runtime.adapter.dispatchCommand({ kind: 'openView', commandId: 'snapshot-open', focus: true, ...view,
                platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url: `http://127.0.0.1:${address.port}/` },
            })).toMatchObject({ status: 'dispatched' });
            const context = createBrowserContextRoutes({ ownerAccountId: 'snapshot_machine',
                source: createSidecarCdpBrowserContextSource({ contextCapture: capture, workingDirectory: root,
                    screenshotMediaStorage: 'daemon', pathAllowanceRegistry: createTransferPathAllowanceRegistry() }),
                resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
            });
            const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
                transport: createControlAdapterAutomationTransport({ adapter: runtime.adapter, contextCapture: capture, browserContext: context }),
            }) });
            service = automation;
            let request = 0;
            const action = (actionKind: BrowserAutomationActionRequestV1['actionKind'], payload = {}) => automation.execute({
                v: 1, ...view, automationRequestId: `snapshot:${++request}`, actionKind, payload,
                navigationGeneration: capture.getNavigationState?.(view)?.navigationGeneration ?? 0,
                requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'snapshot-fixture' }, timeoutMs: 60_000,
            });
            expect(await action('waitFor', { selector: '#public' })).toMatchObject({ status: 'succeeded' });
            for (const kind of ['snapshot', 'semanticSnapshot'] as const) {
                const result = await action(kind);
                expect(result).toMatchObject({ status: 'succeeded', resultSummary: { visibleText: expect.stringContaining('Public snapshot content') } });
                expect(JSON.stringify(result)).not.toContain('password-canary');
                expect(JSON.stringify(result)).not.toContain('css-canary');
            }
        } finally {
            service?.dispose();
            try { if (runtime?.ok) await runtime.dispose?.(); }
            finally {
                await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                await rm(root, { recursive: true, force: true });
            }
        }
    });
});
