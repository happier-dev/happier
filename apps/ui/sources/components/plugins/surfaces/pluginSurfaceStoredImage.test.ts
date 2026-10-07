import { describe, expect, it } from 'vitest';
import type { DaemonPluginStoredImageReadResponse, SessionImageMediaReferenceV1 } from '@happier-dev/protocol';
import { PluginUiSurfaceContextV1Schema, type PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';
import { createPluginSurfaceStoredImageOwner } from './pluginSurfaceStoredImage';

const media: SessionImageMediaReferenceV1 = {
    mediaId: 'image-1', mediaKind: 'image', width: 100, height: 60, sizeBytes: 24,
    file: { sessionId: 'session-1', storage: 'daemon', path: '.happier/uploads/artifacts/session-1/image.png',
        sha256: 'a'.repeat(64), mimeType: 'image/png' },
};
function request(image = media): PluginUiHostApiRequestEnvelopeV1 {
    return { version: 1, requestId: 'read-1', surface: PluginUiSurfaceContextV1Schema.parse({
        pluginId: 'acme.capture', contributionId: 'viewer', surfaceId: 'surface-1', placement: 'appSurface',
        platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [],
    }), method: 'readStoredImage',
        payload: { image } };
}
const image = { bytesBase64: 'cG5n', mimeType: 'image/png' as const, width: 100, height: 60 };

describe('mounted stored image authority', () => {
    it('hands the same native reference to Session admission across remounts and plugin handoff', async () => {
        const received: unknown[] = [];
        for (const pluginId of ['acme.capture', 'acme.capture', 'other.capture']) {
            const owner = createPluginSurfaceStoredImageOwner({ pluginId, occurrenceId: 'occ-1',
                machineId: 'machine-1', serverId: 'server-1', isCurrent: () => true, lifetimeSignal: new AbortController().signal,
                // Substitute only the authenticated daemon transport, not Session admission.
                read: async (_machineId, input) => { received.push(input); return { ok: true, image }; } });
            expect(await owner.readStoredImage(request())).toEqual(image);
            owner.dispose();
        }
        expect(received).toEqual(['acme.capture', 'acme.capture', 'other.capture'].map(callerPluginId =>
            ({ callerPluginId, expectedCallerOccurrenceId: 'occ-1', media })));
    });

    it('preserves daemon scope denial and rejects missing file facts at the input boundary', async () => {
        const received: unknown[] = [];
        const owner = createPluginSurfaceStoredImageOwner({ pluginId: 'acme.capture', occurrenceId: 'occ-1',
            machineId: 'machine-1', serverId: null, isCurrent: () => true, lifetimeSignal: new AbortController().signal,
            read: async (_machineId, input) => { received.push(input); return { ok: false, code: 'plugin_session_scope_unavailable' }; } });
        expect(await owner.readStoredImage(request())).toMatchObject({ code: 'unavailable', diagnostics: ['plugin_session_scope_unavailable'] });
        expect(await owner.readStoredImage(request({ ...media, file: undefined }))).toMatchObject({ code: 'invalid_payload' });
        expect(received).toHaveLength(1);
    });

    it('fences an in-flight disclosure when the mount retires', async () => {
        let finish: ((result: DaemonPluginStoredImageReadResponse) => void) | undefined;
        const lifetime = new AbortController();
        const owner = createPluginSurfaceStoredImageOwner({ pluginId: 'acme.capture', occurrenceId: 'occ-1',
            machineId: 'machine-1', serverId: null, isCurrent: () => true, lifetimeSignal: lifetime.signal,
            read: () => new Promise((resolve) => { finish = resolve; }) });
        const pending = owner.readStoredImage(request());
        owner.dispose();
        finish?.({ ok: true, image });
        expect(await pending).toMatchObject({ code: 'stale_surface' });
        expect(await owner.readStoredImage(request())).toMatchObject({ code: 'stale_surface' });
    });

    it('propagates caller cancellation and suppresses a late daemon disclosure', async () => {
        let finish: ((result: DaemonPluginStoredImageReadResponse) => void) | undefined;
        let daemonSignal: AbortSignal | undefined;
        const caller = new AbortController();
        const owner = createPluginSurfaceStoredImageOwner({ pluginId: 'acme.capture', occurrenceId: 'occ-1',
            machineId: 'machine-1', serverId: null, isCurrent: () => true, lifetimeSignal: new AbortController().signal,
            read: (_machineId, _request, options) => { daemonSignal = options.signal; return new Promise((resolve) => { finish = resolve; }); } });
        const pending = owner.readStoredImage(request(), { signal: caller.signal });
        caller.abort();
        expect(daemonSignal?.aborted).toBe(true);
        finish?.({ ok: true, image });
        expect(await pending).toMatchObject({ code: 'unavailable', diagnostics: ['aborted'] });
        owner.dispose();
    });
});
