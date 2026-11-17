import { createReadStream, statSync } from 'node:fs';
import { GuestCliPayloadV1Schema, type GuestCliPayloadV1 } from '@happier-dev/protocol/features/payload/capabilities/guestCliIdentityV1';
import type { FastifyInstance } from 'fastify';

declare const __HAPPIER_DEV_GUEST_CLI_EXPORT_AVAILABLE__: boolean;

type SourceGuestCliArchive = Readonly<{ payload: GuestCliPayloadV1; archivePath: string }>;

/** The source producer owns paths and hashes; the operator only enables publication. */
function readSourceGuestCliArchives(env: NodeJS.ProcessEnv): readonly SourceGuestCliArchive[] {
    if (typeof __HAPPIER_DEV_GUEST_CLI_EXPORT_AVAILABLE__ !== 'undefined' && !__HAPPIER_DEV_GUEST_CLI_EXPORT_AVAILABLE__) return [];
    if (env.HAPPIER_DEV_GUEST_CLI_EXPORT !== '1') return [];
    try {
        const metadata: unknown = JSON.parse(env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA ?? 'null');
        if (!metadata || typeof metadata !== 'object' || !('archives' in metadata) || !Array.isArray(metadata.archives)) return [];
        return metadata.archives.flatMap((archive: unknown) => {
            if (!archive || typeof archive !== 'object' || !('target' in archive) || !('sha256' in archive)
                || !('archivePath' in archive) || typeof archive.archivePath !== 'string') return [];
            const target = archive.target;
            if (!target || typeof target !== 'object' || !('os' in target) || !('arch' in target)) return [];
            const parsed = GuestCliPayloadV1Schema.safeParse({ target, sha256: archive.sha256,
                url: `/v1/runtime/guest-cli/payloads/${String(target.os)}/${String(target.arch)}` });
            if (!parsed.success || !statSync(archive.archivePath).isFile()) return [];
            return [{ payload: parsed.data, archivePath: archive.archivePath }];
        });
    } catch { return []; }
}

export function readServerGuestCliPayloads(env: NodeJS.ProcessEnv): GuestCliPayloadV1[] {
    return readSourceGuestCliArchives(env).map(archive => archive.payload);
}

/** Public bootstrap transport, restricted to archives named by the captured producer. */
export function registerServerGuestCliPayloadRoutes(app: FastifyInstance): void {
    if (typeof __HAPPIER_DEV_GUEST_CLI_EXPORT_AVAILABLE__ !== 'undefined' && !__HAPPIER_DEV_GUEST_CLI_EXPORT_AVAILABLE__) return;
    app.get<{ Params: { os: string; arch: string } }>('/v1/runtime/guest-cli/payloads/:os/:arch', async (request, reply) => {
        const archive = readSourceGuestCliArchives(process.env).find(candidate =>
            candidate.payload.target.os === request.params.os && candidate.payload.target.arch === request.params.arch);
        if (!archive) return reply.code(404).send();
        return reply.type('application/gzip').send(createReadStream(archive.archivePath));
    });
}
