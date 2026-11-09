import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { buildCodeBuddySubscriptionConfiguration, createCodeBuddySubscriptionLaunch } from './connectedAccounts.js';

// Opt-in public-artifact contract probe. No installed Agent, real home, or
// account is read. Run through hstack-exec AUTO with this environment flag.
it.skipIf(process.env.HAPPIER_CODEBUDDY_NATIVE_PROBE !== '1')('CodeBuddy 2.181.0 consumes the launch overlay and emits the ChatGPT Responses contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-codebuddy-wire-'));
  let child: ReturnType<typeof spawn> | undefined;
  let launch: ReturnType<typeof createCodeBuddySubscriptionLaunch> | undefined;
  const requests: Array<{ path: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let captured!: () => void;
  const requestReceived = new Promise<void>((resolve) => { captured = resolve; });
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requests.push({ path: request.url ?? '', headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"error":{"type":"authentication_error","message":"dummy fixture complete"}}');
    captured();
  });
  try {
    const artifact = await fetch('https://registry.npmjs.org/@tencent-ai/codebuddy-code/-/codebuddy-code-2.181.0.tgz');
    expect(artifact.ok).toBe(true);
    await writeFile(join(directory, 'codebuddy.tgz'), new Uint8Array(await artifact.arrayBuffer()));
    const extraction = spawn('tar', ['-xzf', join(directory, 'codebuddy.tgz'), '-C', directory]);
    expect((await once(extraction, 'exit'))[0]).toBe(0);
    await mkdir(join(directory, 'home'));
    await mkdir(join(directory, 'home', '.codebuddy'));
    await writeFile(join(directory, 'home', '.codebuddy', 'settings.json'), JSON.stringify({ env: {
      CODEBUDDY_CUSTOM_HEADERS: 'chatgpt-account-id: hostile-saved-account\nauthorization: Bearer hostile-saved-token',
    } }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback fixture has no TCP address');
    const configuration = buildCodeBuddySubscriptionConfiguration({ modelId: 'gpt-5.6-sol', materialized: {
      kind: 'httpHeaders', headers: { Authorization: 'Bearer dummy-public-fixture', 'ChatGPT-Account-Id': 'fixture-account' },
    } });
    const overlay = JSON.parse(configuration.env.ACC_PRODUCT_CONFIG_V3);
    overlay.models[0].url = `http://127.0.0.1:${address.port}/backend-api/codex`;
    launch = createCodeBuddySubscriptionLaunch(configuration);
    child = spawn(process.execPath, [join(directory, 'package/bin/codebuddy'), '-p', 'Reply hi', ...launch.args], {
      cwd: directory, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: join(directory, 'home'), CI: '1', TERM: 'dumb',
        CODEBUDDY_DISABLE_ANALYTICS: '1', CODEBUDDY_DISABLE_AUTO_UPDATE: '1', ...configuration.env,
        ACC_PRODUCT_CONFIG_V3: JSON.stringify(overlay) },
    });
    await Promise.race([requestReceived, once(child, 'exit').then(() => { throw new Error('CodeBuddy exited before its model request'); })]);
    const [request] = requests;
    expect(request.path).toBe('/backend-api/codex/responses');
    expect(request.headers.authorization).toBe('Bearer dummy-public-fixture');
    expect(request.headers['chatgpt-account-id']).toBe('fixture-account');
    expect(request.headers['openai-beta']).toBe('responses=experimental');
    expect(request.headers.originator).toBe('codex_cli_rs');
    expect(request.body).toMatchObject({ model: 'gpt-5.6-sol', store: false, stream: true, include: ['reasoning.encrypted_content'] });
    expect(request.body.instructions).toEqual(expect.any(String));
    expect(request.body.input).toEqual(expect.any(Array));
    expect(request.body.tools).toEqual(expect.any(Array));
    for (const key of ['max_output_tokens', 'max_completion_tokens', 'temperature', 'top_p']) expect(request.body).not.toHaveProperty(key);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    launch?.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
