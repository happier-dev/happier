import { createServer } from 'node:http';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createDeferred } from '@/testkit/async/deferred';

export const KIMI_FIXTURE_FOREGROUND = 'KIMI_FIXTURE_FOREGROUND_COMPLETE';
export const KIMI_FIXTURE_BACKGROUND = 'KIMI_FIXTURE_BACKGROUND_COMPLETE';
export const KIMI_FIXTURE_NESTED_BACKGROUND = 'KIMI_FIXTURE_NESTED_BACKGROUND_COMPLETE';
export const KIMI_FIXTURE_SECOND_FOREGROUND = 'KIMI_FIXTURE_SECOND_FOREGROUND_COMPLETE';

/** Keep every official fixture process on its loopback config, regardless of the invoking shell. */
export function createKimiLoopbackEnvironment(home: string, executable: string): {
    env: Record<string, string>;
    unsetEnv: string[];
} {
    const env = { HAPPIER_KIMI_PATH: executable, KIMI_CODE_HOME: home, KIMI_DISABLE_TELEMETRY: '1' };
    return {
        env,
        unsetEnv: Object.keys(process.env).filter(key => /^(KIMI_|OPENAI_|ANTHROPIC_)/i.test(key)
            && !Object.keys(env).some(owned => owned.toLowerCase() === key.toLowerCase())),
    };
}

export type KimiLoopbackModelOptions = Readonly<{
    continuationPlan?: boolean;
    holdAfterPlan?: boolean;
    filesystem?: Readonly<{ tool: 'Read' | 'Write'; path: string; content?: string }>;
    plain?: boolean;
    subagent?: boolean;
    mcpTool?: boolean;
    continuationTool?: boolean;
    nestedBackground?: boolean;
    interveningForeground?: boolean;
}>;

/** Script only the model boundary; the official CLI owns tools, tasks and turns. */
export async function createKimiLoopbackModel(directory: string, options: KimiLoopbackModelOptions = {}) {
    const home = join(directory, 'kimi-home');
    const workspace = join(directory, 'workspace');
    await mkdir(home, { mode: 0o700 });
    await mkdir(workspace);
    const continuationRequested = createDeferred();
    const continuationResponse = createDeferred();
    const afterPlanRequested = createDeferred();
    const afterPlanResponse = createDeferred();
    let requests = 0;
    let toolResponses: string[] = [];
    let userContents: unknown[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            tools?: Array<{ function?: { name?: string } }>;
            messages?: Array<{ role?: string; content?: unknown }>;
        };
        toolResponses = body.messages?.filter((message) => message.role === 'tool' && typeof message.content === 'string')
            .map((message) => message.content as string) ?? [];
        // Only the isolated fixture input is observed for skill/media delivery.
        userContents = body.messages?.filter((message) => message.role === 'user').map((message) => message.content) ?? [];
        const mcpToolName = body.tools?.map((tool) => tool.function?.name)
            .find((name) => name?.endsWith('fixture_probe'));
        const index = ++requests;
        if (options.continuationPlan && options.holdAfterPlan && index === (options.interveningForeground ? 5 : 4)) {
            afterPlanRequested.resolve();
            await afterPlanResponse.promise;
        }
        let delta: Record<string, unknown>;
        let finishReason = 'stop';
        if (options.filesystem) {
            delta = index === 1 ? { role: 'assistant', tool_calls: [{
                index: 0, id: 'call_filesystem_fixture', type: 'function',
                function: { name: options.filesystem.tool, arguments: JSON.stringify({
                    path: options.filesystem.path,
                    ...(options.filesystem.content !== undefined ? { content: options.filesystem.content } : {}),
                }) },
            }] } : { role: 'assistant', content: KIMI_FIXTURE_FOREGROUND };
            if (index === 1) finishReason = 'tool_calls';
        } else if (options.plain) {
            delta = { role: 'assistant', content: KIMI_FIXTURE_FOREGROUND };
        } else if (options.mcpTool && index === 1) {
            delta = mcpToolName ? { role: 'assistant', tool_calls: [{
                index: 0, id: 'call_mcp_fixture', type: 'function',
                function: { name: mcpToolName, arguments: '{}' },
            }] } : { role: 'assistant', content: 'MCP_FIXTURE_TOOL_MISSING' };
            if (mcpToolName) finishReason = 'tool_calls';
        } else if (options.subagent) {
            if (index === 1) {
                delta = { role: 'assistant', tool_calls: [{
                    index: 0, id: 'call_child', type: 'function',
                    function: { name: 'Agent', arguments: JSON.stringify({
                        prompt: 'Attempt the isolated sentinel command and report the decision.',
                        description: 'Isolated subagent permission fixture',
                    }) },
                }] };
                finishReason = 'tool_calls';
            } else if (index === 2) {
                delta = { role: 'assistant', tool_calls: [{
                    index: 0, id: 'call_child_bash', type: 'function',
                    function: { name: 'Bash', arguments: JSON.stringify({
                        command: 'printf child_executed > continuation-executed',
                    }) },
                }] };
                finishReason = 'tool_calls';
            } else {
                delta = { role: 'assistant', content: index === 3 ? 'CHILD_COMPLETE' : KIMI_FIXTURE_FOREGROUND };
            }
        } else if (index === 1) {
            delta = { role: 'assistant', tool_calls: [{
                index: 0, id: 'call_background', type: 'function',
                function: { name: 'Bash', arguments: JSON.stringify({
                    command: 'while [ ! -f release-background ]; do sleep 0.1; done; printf background_done',
                    run_in_background: true,
                    description: 'Wait for the isolated test signal',
                }) },
            }] };
            finishReason = 'tool_calls';
        } else if (index === 2) {
            delta = { role: 'assistant', content: KIMI_FIXTURE_FOREGROUND };
        } else if (options.interveningForeground && index === 3) {
            delta = { role: 'assistant', content: KIMI_FIXTURE_SECOND_FOREGROUND };
        } else if (index === (options.interveningForeground ? 4 : 3)) {
            continuationRequested.resolve();
            await continuationResponse.promise;
            if (options.continuationPlan) {
            delta = { role: 'assistant', tool_calls: [{
                index: 0, id: 'call_todo', type: 'function',
                function: { name: 'TodoList', arguments: JSON.stringify({ todos: [
                    { title: 'FIXTURE_INVESTIGATE', status: 'done' },
                    { title: 'FIXTURE_REPAIR', status: 'in_progress' },
                    { title: 'FIXTURE_VERIFY', status: 'pending' },
                ] }) },
            }] };
            finishReason = 'tool_calls';
            } else if (options.continuationTool || options.nestedBackground) {
                delta = { role: 'assistant', tool_calls: [{
                    index: 0, id: 'call_continuation', type: 'function',
                    function: { name: 'Bash', arguments: JSON.stringify({
                        command: options.nestedBackground
                            ? 'while [ ! -f release-background ]; do sleep 0.1; done; printf background_done'
                            : 'printf executed > continuation-executed',
                        ...(options.nestedBackground ? { run_in_background: true } : {}),
                        description: options.nestedBackground ? 'Wait for the isolated test signal' : 'Create the isolated approval sentinel',
                    }) },
                }] };
                finishReason = 'tool_calls';
            } else {
                delta = { role: 'assistant', content: KIMI_FIXTURE_BACKGROUND };
            }
        } else {
            delta = { role: 'assistant', content: options.nestedBackground && index >= 5
                ? KIMI_FIXTURE_NESTED_BACKGROUND : KIMI_FIXTURE_BACKGROUND };
        }
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = { id: `fixture-${index}`, object: 'chat.completion.chunk', created: 0, model: 'fixture' };
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
        response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback model did not bind');
    await writeFile(join(home, 'config.toml'), `defaultModel = "fixture"
[models.fixture]
name = "fixture"
protocol = "openai"
baseUrl = "http://127.0.0.1:${address.port}/v1"
apiKey = "fixture-only"
maxContextSize = 262144
`, { mode: 0o600 });

    return {
        home,
        workspace,
        continuationRequested: continuationRequested.promise,
        afterPlanRequested: afterPlanRequested.promise,
        releaseAfterPlan: () => afterPlanResponse.resolve(),
        releaseContinuation: () => continuationResponse.resolve(),
        releaseBackground: () => writeFile(join(workspace, 'release-background'), 'ready'),
        getRequestCount: () => requests,
        getToolResponses: () => toolResponses,
        getUserContents: () => userContents,
        continuationExecuted: () => access(join(workspace, 'continuation-executed')).then(() => true, () => false),
        async readNativeEvents(): Promise<Record<string, unknown>[]> {
            const sessions = join(home, 'sessions');
            const files = await readdir(sessions, { recursive: true }).catch(() => []);
            const events: Record<string, unknown>[] = [];
            for (const file of files.filter((entry) => entry.endsWith('agents/main/wire.jsonl'))) {
                const contents = await readFile(join(sessions, file), 'utf8');
                for (const line of contents.split('\n')) {
                    try {
                        const event: unknown = JSON.parse(line);
                        if (event && typeof event === 'object' && !Array.isArray(event)) {
                            events.push(event as Record<string, unknown>);
                        }
                    } catch { /* A native writer may still be appending its final line. */ }
                }
            }
            return events;
        },
        async close() {
            continuationResponse.resolve();
            afterPlanResponse.resolve();
            await writeFile(join(workspace, 'release-background'), 'ready');
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    };
}
