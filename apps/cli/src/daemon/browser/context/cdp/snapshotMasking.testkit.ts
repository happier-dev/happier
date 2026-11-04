import { browserContextSensitiveFieldsExpression } from '@happier-dev/protocol/browser/context/privacy';
import type { BrowserSidecarContextCaptureSurface } from '../../sidecar/controlAdapter';
import { createBrowserContextRoutes } from '../routes';
import { createCdpBrowserContextSource } from './source';

// Chromium/CDP boundary fixture shared by context and automation composed tests.
export function createSnapshotMaskingFixture(fields: Array<{ type?: string; security?: string; value: string; text?: boolean }> = []) {
    const strings = ['#document', '', 'INPUT', 'DIV', 'type', 'password', 'none', '#text'];
    const intern = (value: string) => { strings.push(value); return strings.length - 1; };
    const nodes = { parentIndex: [-1], nodeName: [0], nodeValue: [1], attributes: [[]] as number[][],
        inputValue: { index: [] as number[], value: [] as number[] } };
    // Chromium includes the document's LayoutView but it has no Element/computed style.
    const layout = { nodeIndex: [0], styles: [[]] as number[][] };
    for (const field of fields) {
        const index = nodes.nodeName.length;
        nodes.parentIndex.push(0);
        nodes.nodeName.push(field.text ? 3 : 2);
        nodes.nodeValue.push(1);
        nodes.attributes.push(field.type ? [4, intern(field.type)] : []);
        layout.nodeIndex.push(index);
        layout.styles.push([intern(field.security ?? 'none')]);
        if (field.text) {
            nodes.parentIndex.push(index);
            nodes.nodeName.push(7);
            nodes.nodeValue.push(intern(field.value));
            nodes.attributes.push([]);
        } else {
            nodes.inputValue.index.push(index);
            nodes.inputValue.value.push(intern(field.value));
        }
    }
    return { strings, documents: [{ nodes, layout }] };
}

export function snapshotReadBoundaryFixture(command: Readonly<{ method: string; params?: Record<string, unknown> }>): unknown {
    if (command.method === 'DOMSnapshot.captureSnapshot') return createSnapshotMaskingFixture();
    if (command.method === 'Runtime.evaluate' && command.params?.expression === browserContextSensitiveFieldsExpression) {
        return { result: { type: 'boolean', value: false } };
    }
    return undefined;
}

// Keep the real source, gate, and routes in composed tests; only CDP and media are boundaries.
export function createSnapshotCaptureTestRoutes(surface: BrowserSidecarContextCaptureSurface) {
    return createBrowserContextRoutes({ ownerAccountId: 'owner',
        resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
        source: createCdpBrowserContextSource({ transport: surface.transport, resolveView: surface.resolvePageHandle,
            screenshotMediaWriter: { write: async () => ({ ok: false, reason: 'capture_failed' }) } }),
    });
}
