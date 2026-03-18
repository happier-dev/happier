import type { StartedDaemon } from '../daemon/daemon';

export async function spawnSessionFromDaemon(params: Readonly<{
    daemon: StartedDaemon;
    directory: string;
    agent?: string;
}>): Promise<string> {
    const token = params.daemon.state.controlToken;
    if (!token) throw new Error('daemon control token missing');

    const res = await fetch(`http://127.0.0.1:${params.daemon.state.httpPort}/spawn-session`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-happier-daemon-token': token,
        },
        body: JSON.stringify({
            directory: params.directory,
            agent: params.agent ?? 'claude',
        }),
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok || !json || json.success !== true || typeof json.sessionId !== 'string') {
        throw new Error(`Failed to spawn session (status=${res.status}): ${JSON.stringify(json)}`);
    }
    return json.sessionId as string;
}
