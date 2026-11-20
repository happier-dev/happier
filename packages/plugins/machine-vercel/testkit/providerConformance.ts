import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Vercel Sandbox REST boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, guest, body, decode, text, name, managedId, directory } = world;
    const foreignId = 'happier-foreign';
    const commands = new Map<string, { command: string; args: string[]; stdin: Buffer[]; output?: string; stderr?: string; exitCode?: number }>();
    const sandbox = () => ({ name, createdAt: 1000, currentSessionId: 'sbx_one', currentSnapshotId: 'snap_one', status: s.power,
        persistent: true, ...(s.evidence ? { expiresAt: world.nativeExpiry } : {}), tags: { 'happier-managed-id': managedId }, networkPolicy: { mode: 'allow-all' } });
    const session = () => ({ id: 'sbx_one', sourceSandboxName: name, projectId: 'prj_one', createdAt: 1000, networkPolicy: { mode: 'allow-all' } });
    const snapshot = () => ({ id: 'snap_one', sourceSessionId: 'sbx_one', status: 'created', createdAt: 2000 });
    function commandResponse(id: string, exitCode: number | null) {
        const c = commands.get(id)!;
        return { command: { id, sessionId: 'sbx_one', exitCode, args: c.args, name: c.command, cwd: directory, startedAt: 2000 } };
    }
    return {
        foreignId, launch: { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 2, timeoutMs: 300000, snapshotExpirationMs: 0 },
        account: { environment: { VERCEL_TEAM_ID: 'team_one', VERCEL_PROJECT_ID: 'prj_one' } },
        facts: { nativeExpiry: 'with-evidence' },
        http(request, { url, path, method }) {
            if (path === `/v2/sandboxes/${foreignId}`) {
                if (method === 'DELETE') s.foreignPresent = false;
                return { status: s.foreignPresent || method === 'DELETE' ? 200 : 404, finalUrl: request.url,
                    headers: { 'content-type': 'application/json' }, body: text.encode(JSON.stringify({ sandbox: { ...sandbox(), name: foreignId }, session: session(), routes: [] })) };
            }
            if (path.startsWith('/v9/projects/')) return { value: { id: 'prj_one' } };
            if (path.startsWith('/v2/teams/')) return { value: { id: 'team_one', billing: { plan: 'hobby' } } };
            if (path === '/v4/sandboxes') { s.allocations++; s.present = true; s.owned.add('sandbox'); return { value: { sandbox: sandbox(), session: session(), routes: [] } }; }
            if (path === '/v2/sandboxes/' + name) {
                if (method === 'DELETE') { s.present = false; s.owned.delete('sandbox'); if (url.searchParams.get('deleteOrphanSnapshots') === 'true') s.owned.delete('snapshot'); }
                if (url.searchParams.get('resume') === 'true') s.power = 'running';
                return { status: !s.present && method !== 'DELETE' ? 404 : 200, value: { sandbox: sandbox(), session: session(), routes: [] } };
            }
            if (path === '/v2/sandboxes/snapshots') return { value: { snapshots: s.owned.has('snapshot') ? [snapshot()] : [], pagination: { next: null, count: s.owned.has('snapshot') ? 1 : 0 } } };
            if (path.includes('/snapshots/')) {
                if (method === 'DELETE') { if (!path.endsWith('/snapshots/snap_one')) throw new Error(`Unexpected Vercel snapshot deletion: ${path}`); s.owned.delete('snapshot'); }
                return { status: s.owned.has('snapshot') ? 200 : 404, value: { snapshot: snapshot() } };
            }
            if (path.endsWith('/stop')) { s.power = 'stopped'; s.owned.add('snapshot'); return { value: { sandbox: sandbox(), session: session(), snapshot: snapshot() } }; }
            if (/\/sessions\/[^/]+$/.test(path)) return { value: { session: session() } };
            if (path.endsWith('/cmd')) { const b = body(request); const id = 'cmd_' + commands.size; commands.set(id, { command: String(b.command), args: b.args as string[], stdin: [] }); return { value: commandResponse(id, null) }; }
            if (path.includes('/cmd/')) {
                const [id, suffix] = path.split('/cmd/')[1]!.split('/'); const c = commands.get(id!)!;
                const finish = () => { if (c.output === undefined) { const completed = guest([c.command, ...c.args], Buffer.concat(c.stdin)); c.output = decode.decode(completed.stdout); c.stderr = decode.decode(completed.stderr); c.exitCode = completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1; } return c.output; };
                if (suffix === 'stdin') { const b = body(request); c.stdin.push(Buffer.from(String(b.data), 'base64')); if (b.close) finish(); return { value: { ...commandResponse(id!, b.close ? c.exitCode! : null), bytesWritten: Buffer.concat(c.stdin).length } }; }
                if (suffix === 'logs') { finish(); return { value: JSON.stringify({ stream: 'stdout', data: c.output }) + '\n' + JSON.stringify({ stream: 'stderr', data: c.stderr }) + '\n', contentType: 'application/x-ndjson' }; }
                finish(); return { value: commandResponse(id!, c.exitCode!) };
            }
            throw new Error(`Unexpected Vercel HTTP ${method} ${path}`);
        },
    };
};
