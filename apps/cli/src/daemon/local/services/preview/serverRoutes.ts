import axios from 'axios';
import { Readable } from 'node:stream';
import { LocalServicePreviewNativeRegistrationAdmittedV1Schema, LocalServicePreviewNativeRegistrationRequestV1Schema } from '@happier-dev/protocol/local/services/preview/nativeDirect';
import type { LocalServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { LocalServicePreviewSnapshotRowV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import type { LocalServicePreviewResourceV1, LocalServicePreviewSnapshotRowV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export type LocalServicePreviewServerInput = Readonly<{
    token: string;
    serverBaseUrl?: string;
    http?: Readonly<{
        post(url: string, body: unknown, options: Readonly<{ headers: Readonly<Record<string, string>>; responseType?: 'stream'; signal?: AbortSignal; timeout?: number }>): Promise<Readonly<{ data: unknown }>>;
        delete(url: string, options: Readonly<{ headers: Readonly<Record<string, string>> }>): Promise<Readonly<{ data: unknown }>>;
    }>;
}>;

export function createLocalServicePreviewServerRoutes(input: LocalServicePreviewServerInput) {
    const http = input.http ?? axios;
    const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.token}` };
    const endpoint = (path: string) => `${(input.serverBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/u, '')}${path}`;
    return {
        async acquireNativeRegistration(binding: LocalServicePreviewDirectBindingV1, grantId: string, signal?: AbortSignal): Promise<Readonly<{ signal: AbortSignal; close: () => void }>> {
            const abort = new AbortController();
            const cancel = () => abort.abort(signal?.reason);
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) cancel();
            let stream: Readable | undefined;
            const close = () => {
                signal?.removeEventListener('abort', cancel);
                abort.abort();
                stream?.destroy();
            };
            try {
                // This control request lives with registration/viewer custody, not a finite RPC deadline.
                const request = LocalServicePreviewNativeRegistrationRequestV1Schema.parse({ ...binding, grantId });
                const response = await http.post(endpoint(`/v1/local-services/preview/${encodeURIComponent(binding.previewId)}/native-registration`), request,
                    { headers, responseType: 'stream', signal: abort.signal, timeout: 0 });
                if (!(response.data instanceof Readable)) throw new Error('invalid_native_preview_registration');
                stream = response.data;
                const registrationStream = stream;
                let ready = false;
                await new Promise<void>((resolve, reject) => {
                    let head = '';
                    const onTerminal = () => {
                        close();
                        if (!ready) reject(new Error('native_preview_registration_closed'));
                    };
                    const onData = (chunk: Buffer | string) => {
                        head += chunk.toString();
                        const end = head.indexOf('\n');
                        if (end < 0) return;
                        registrationStream.off('data', onData);
                        try {
                            const admitted = LocalServicePreviewNativeRegistrationAdmittedV1Schema.parse(JSON.parse(head.slice(0, end)));
                            if (admitted.previewId !== binding.previewId || abort.signal.aborted) throw new Error('native_preview_registration_mismatch');
                            ready = true;
                            resolve();
                        } catch (error) { close(); reject(error); }
                    };
                    registrationStream.once('end', onTerminal);
                    registrationStream.once('close', onTerminal);
                    registrationStream.once('error', onTerminal);
                    registrationStream.on('data', onData);
                });
                abort.signal.throwIfAborted();
                return { signal: abort.signal, close };
            } catch (error) { close(); throw error; }
        },
        async registerPreview(resource: LocalServicePreviewResourceV1, signal?: AbortSignal): Promise<LocalServicePreviewSnapshotRowV1> {
            const response = await http.post(endpoint('/v1/local-services/preview'), resource, { headers, ...(signal ? { signal } : {}) });
            const payload: unknown = response.data;
            if (typeof payload !== 'object' || payload === null) throw new Error('invalid_preview_registration');
            const row = LocalServicePreviewSnapshotRowV1Schema.parse({ ...payload, previewId: resource.previewId, diagnostics: [] });
            if (row.resource.previewId !== resource.previewId || row.resource.machineId !== resource.machineId
                || row.resource.sessionId !== resource.sessionId || JSON.stringify(row.resource.target) !== JSON.stringify(resource.target)
                || (!row.accessUrl || row.expiresAt === null) && row.accessUnavailableReasonCode !== 'preview_private_route_unavailable'
                || row.accessUnavailableReasonCode && (row.accessUrl !== null || row.expiresAt !== null)) throw new Error('preview_registration_binding_mismatch');
            return row;
        },
        async unregisterPreview(previewId: string): Promise<void> {
            try {
                const response = await http.delete(endpoint(`/v1/local-services/preview/${encodeURIComponent(previewId)}`), { headers });
                if (typeof response.data !== 'object' || response.data === null || !('ok' in response.data) || response.data.ok !== true) {
                    throw new Error('invalid_preview_revocation');
                }
            } catch (error) {
                // A hosted service can stop before any viewer publishes its registration.
                if (axios.isAxiosError(error) && error.response?.status === 404) {
                    const payload: unknown = error.response.data;
                    if (typeof payload === 'object' && payload !== null && 'reasonCode' in payload
                        && payload.reasonCode === 'preview_not_found') return;
                }
                throw error;
            }
        },
    };
}
