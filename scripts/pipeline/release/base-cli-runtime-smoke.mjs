// @ts-check

export function createBaseCliRuntimeSmokeSource({ root, scratch, targetOs }) {
  return `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { createRequire } from 'node:module';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';

    const root = ${JSON.stringify(root)};
    const scratch = ${JSON.stringify(scratch)};
    const targetOs = ${JSON.stringify(targetOs)};
    const runtimeRequire = createRequire(join(root, 'runtime-smoke.cjs'));

    const claudeFixturePath = join(scratch, 'claude-runtime-smoke.js');
    const claudeWorkDir = join(scratch, 'claude-work');
    await mkdir(claudeWorkDir, { recursive: true });
    await writeFile(claudeFixturePath, ${JSON.stringify(`
      const readline = require('node:readline');
      const input = readline.createInterface({ input: process.stdin });
      let sent = false;
      input.on('line', () => {
        if (sent) return;
        sent = true;
        process.stdout.write(JSON.stringify({ type: 'result', result: 'fixture-ok' }) + '\\n');
      });
    `)});

    const claudeSdkEntry = runtimeRequire.resolve('@anthropic-ai/claude-agent-sdk');
    const { createSdkMcpServer, query, tool } = await import(pathToFileURL(claudeSdkEntry).href);
    process.stderr.write('[release] base CLI runtime smoke: Claude SDK query\\n');
    const claudeQuery = query({
      prompt: 'runtime-smoke',
      options: {
        cwd: claudeWorkDir,
        executable: process.execPath,
        pathToClaudeCodeExecutable: claudeFixturePath,
        settingSources: [],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: '',
          CLAUDE_CODE_OAUTH_TOKEN: '',
          CLAUDE_CONFIG_DIR: join(scratch, 'claude-config'),
        },
      },
    });
    try {
      const first = await claudeQuery.next();
      if (first.done || first.value?.type !== 'result' || first.value?.result !== 'fixture-ok') {
        throw new Error('Claude Agent SDK query did not execute the generated fixture');
      }
    } finally {
      claudeQuery.close();
    }

    process.stderr.write('[release] base CLI runtime smoke: MCP transport\\n');
    const cjsMcp = runtimeRequire('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = runtimeRequire('@modelcontextprotocol/sdk/inMemory.js');
    if (typeof cjsMcp.Client !== 'function' || typeof InMemoryTransport?.createLinkedPair !== 'function') {
      throw new Error('MCP SDK CommonJS exports are unavailable');
    }
    const { z } = runtimeRequire('zod');
    const echoTool = tool(
      'runtime_echo',
      'Echoes the release runtime smoke value',
      { value: z.string() },
      async ({ value }) => ({ content: [{ type: 'text', text: value }] }),
    );
    const sdkServer = createSdkMcpServer({ name: 'release-runtime-smoke', version: '1.0.0', tools: [echoTool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new cjsMcp.Client({ name: 'release-runtime-smoke', version: '1.0.0' }, { capabilities: {} });
    try {
      await Promise.all([sdkServer.instance.connect(serverTransport), mcpClient.connect(clientTransport)]);
      await mcpClient.ping();
      const tools = await mcpClient.listTools();
      if (!tools.tools?.some((entry) => entry.name === 'runtime_echo')) {
        throw new Error('Claude SDK MCP server tool was not listed by the root MCP client');
      }
      const called = await mcpClient.callTool({ name: 'runtime_echo', arguments: { value: 'mcp-ok' } });
      if (!called.content?.some((entry) => entry.type === 'text' && entry.text === 'mcp-ok')) {
        throw new Error('Claude SDK MCP server tool call did not cross the root in-memory transport');
      }
    } finally {
      await mcpClient.close();
      await sdkServer.instance.close();
    }

    process.stderr.write('[release] base CLI runtime smoke: sharp PNG\\n');
    const sharp = runtimeRequire('sharp');
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (png.length < pngSignature.length || !png.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error('sharp did not encode a 1x1 PNG');
    }

    if (targetOs === 'linux') {
      const homebridgePty = runtimeRequire('@homebridge/node-pty-prebuilt-multiarch');
      if (typeof homebridgePty.spawn !== 'function') throw new Error('Homebridge PTY package did not load');
    }

    process.stderr.write('[release] base CLI runtime smoke: PTY spawn and exit\\n');
    const nodePty = runtimeRequire('node-pty');
    const command = targetOs === 'windows' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    // cmd's set /p prints its prompt but exits 1 at EOF; echo succeeds without input.
    const args = targetOs === 'windows'
      ? ['/d', '/s', '/c', 'echo pty-ok']
      : ['-c', 'printf pty-ok'];
    const ptyOutput = await new Promise((resolvePromise, rejectPromise) => {
      let output = '';
      let pty;
      try {
        pty = nodePty.spawn(command, args, {
          name: 'xterm-color',
          cols: 80,
          rows: 24,
          cwd: root,
          env: process.env,
        });
      } catch (error) {
        rejectPromise(error);
        return;
      }
      pty.onData((chunk) => { output += chunk; });
      pty.onExit(({ exitCode, signal }) => {
        if (exitCode !== 0) {
          rejectPromise(new Error('node-pty child failed with exit ' + exitCode + ' signal ' + signal));
          return;
        }
        resolvePromise(output);
      });
    });
    if (!ptyOutput.includes('pty-ok')) throw new Error('node-pty did not carry subprocess output');
    // ConPTY's conout worker can keep Node alive after onExit. All runtime checks,
    // including the PTY's successful exit and output, have settled before we exit.
    process.stdout.write('[release] base CLI runtime smoke passed\\n', () => process.exit(0));
  `;
}

