import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

/** Substitute the native Agent only; first input and reply still cross the
 * real SDK Session, parent queue, Exec admission and transcript owners. */
export function createFirstConversationAgentFixture(promptMarker: string, options: Readonly<{
  /** The authored external Agent receives the SDK input-id array and composed
   * host prompt as its last arguments. Internal turn logic stays real. */
  nativeReply?: Readonly<{ executableNames: readonly string[]; args: readonly string[] }>;
  workspaceRead?: Readonly<{ relativePath: string; text: string }>;
  /** Native startup is exercised before the parent admits any first input. */
  nativeStartupExec?: true;
  nativeAcp?: Readonly<{ source: string }>;
  /** Voice's retained native conversation must reopen this exact provider id.
   * The external reply program receives the native open request before input. */
  nativeSession?: Readonly<{ providerSessionId: string; storePath?: string; externalSessionsExport?: string }>;
}> = {}) {
  return {
    manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch',
      hostAccess: { required: [{ id: 'native-process', capability: 'process', reason: 'Read the native Agent response',
        scope: { executables: [{ kind: 'systemTool', id: 'native-cli' }] } },
      { id: 'workspace', capability: 'filesystem', reason: 'Use the admitted Session directory',
        scope: { locations: [{ root: 'workspace' }], access: ['read'] } }], optional: [] },
      contributes: {
        systemTools: [{ id: 'native-cli', title: 'Native response', executableNames: [...(options.nativeReply?.executableNames ?? (options.nativeAcp ? [process.execPath] : ['git']))] }],
        agents: [{ id: 'agent', title: 'Conversation fixture', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { ...(options.nativeSession?.externalSessionsExport ? { surfaces: ['externalSessions'] } : {}),
            tools: { delivery: 'native_mcp' }, sessions: { open: options.nativeSession ? ['create', 'resume'] : ['create'], delivery: ['newTurn'], cancel: true,
            executionRunContext: { versions: [1] } } } }],
      } }),
    files: {
      ...(options.nativeAcp ? { 'native-acp.mjs': options.nativeAcp.source } : {}),
      'agent.mjs': `${options.nativeSession?.storePath ? "import { readFile } from 'node:fs/promises';" : ''}
      ${options.nativeAcp ? "import { fileURLToPath } from 'node:url';" : ''}
      async function answer(services, cwd, text, inputIds, nativeOpen, nativeLaunch) {
        ${options.nativeReply ? '' : `if (!text.includes(${JSON.stringify(promptMarker)})) throw new Error('The native Agent did not receive the first public input');`}
        ${options.workspaceRead ? `const file = await services.fs.readFile({ root: 'workspace', relativePath: ${JSON.stringify(options.workspaceRead.relativePath)} });
        if (new TextDecoder().decode(file) !== ${JSON.stringify(options.workspaceRead.text)}) throw new Error('Owned Session File read did not reach its workspace');
        const listed = await services.fs.list({ root: 'workspace', relativePath: '' });
        if (!listed.items.some(item => item.name === ${JSON.stringify(options.workspaceRead.relativePath)} && item.kind === 'file')) throw new Error('Owned Session listing did not reach its workspace');` : ''}
        const executable = await services.exec.systemTools.resolve({ toolId: 'native-cli',
          purpose: 'Answer the first admitted conversation', cwd });
        const result = await services.exec.run({ executable: executable.executable,
          args: ${options.nativeReply ? `[...${JSON.stringify(options.nativeReply.args)}, ${options.nativeSession ? 'JSON.stringify(nativeOpen), ' : ''}JSON.stringify(inputIds ?? []), text]` : "['--version']"}, cwd }, nativeLaunch ? { nativeLaunch } : undefined);
        if (result.termination.observed?.kind !== 'exit' || result.termination.observed.exitCode !== 0) throw new Error('Native response failed');
        return new TextDecoder().decode(result.stdout);
      }
      export function factory() { return { sessions: {
        executionRunContextV1: { async open(request, { services }) {
          if (request.kind !== 'create') throw new Error('First conversation must create one native Run');
          const text = await answer(services, request.cwd, request.input.text, request.localInputId ? [request.localInputId] : []);
          const bodies = [{ kind: 'run-start' }, { kind: 'output-delta', channel: 'assistant', text }, { kind: 'run-complete' }];
          let watched = false;
          return {
            watch(listener) {
              if (watched) throw new Error('First conversation may subscribe only once');
              watched = true;
              bodies.forEach((body, index) => listener({ runId: request.runId, sequence: index + 1, emittedAtMs: Date.now(), ...body }));
              return { dispose() {} };
            },
            async send() { throw new Error('First input must not be sent twice'); },
            async stop() { return { status: 'notRunning' }; }, async dispose() {},
          };
        }, async openConversation(request, { services }) {
          if (request.kind !== 'create') throw new Error('First conversation must create one native Run');
          let listener;
          return {
            watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
            async send(input) {
              listener({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
              listener({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
              const text = await answer(services, request.cwd, input.input.text, input.inputIds);
              listener({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text });
              listener({ kind: 'turn-complete', turnId: input.delivery.turnId });
              return { status: 'admitted' };
            },
            async cancel(input) { return { status: 'requested', turnId: input.turnId }; }, async dispose() {},
          };
        } },
        async open(request, context) {
        const { services } = context;
        ${options.nativeStartupExec ? `const nativeLaunch = context.session.services.nativeLaunch;
        if (!nativeLaunch) throw new Error('Host omitted native startup launch authority');
        await answer(services, request.cwd, ${JSON.stringify(promptMarker)}, [], undefined, nativeLaunch);` : ''}
        ${options.nativeAcp ? `return await context.protocols.acp.open(request, {
          transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'native-cli' },
            args: [fileURLToPath(new URL('./native-acp.mjs', import.meta.url))] },
        });` : ''}
        ${options.nativeSession ? 'const nativeOpenId = globalThis.crypto.randomUUID();' : ''}
        ${options.nativeSession ? `if (request.kind === 'resume' && request.providerSessionId !== ${JSON.stringify(options.nativeSession.providerSessionId)}) throw new Error('Native resume changed the provider Session id');` : ''}
        ${options.nativeSession?.storePath ? `if (request.kind === 'resume') {
          const stored = JSON.parse(await readFile(${JSON.stringify(options.nativeSession.storePath)}, 'utf8'));
          if (stored.providerSessionId !== request.providerSessionId || !stored.turns?.length) throw new Error('Native resume has no retained conversation');
        }` : ''}
        let listener; let sequence = 0;
        const emit = body => listener({ sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: Date.now(), ...body });
        return {
          async send(input) {
            emit({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
            emit({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
            const text = await answer(services, request.cwd, input.input.text, input.inputIds, {
              kind: request.kind, providerSessionId: request.kind === 'resume' ? request.providerSessionId : ${JSON.stringify(options.nativeSession?.providerSessionId ?? null)},
              ${options.nativeSession ? 'openId: nativeOpenId,' : ''}
            });
            emit({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text });
            emit({ kind: 'turn-complete', turnId: input.delivery.turnId });
            return { status: 'admitted' };
          },
          watch(next) { listener = next;
            ${options.nativeSession ? `emit({ kind: 'provider-session-id', providerSessionId: ${JSON.stringify(options.nativeSession.providerSessionId)} });` : ''}
            return { dispose() { listener = undefined; } }; },
          async cancel(input) { return { status: 'requested', turnId: input.turnId }; }, async dispose() {},
        };
      } } }; }`,
      'daemon.mjs': `import { factory${options.nativeSession?.externalSessionsExport ? `, ${options.nativeSession.externalSessionsExport}` : ''} } from './agent.mjs';
        export function activate(api) { api.agents.register('agent', factory, {
          sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1${options.nativeSession?.externalSessionsExport ? `, externalSessionsExport: ${JSON.stringify(options.nativeSession.externalSessionsExport)}` : ''} } });
          ${options.nativeSession?.externalSessionsExport ? `api.agents.registerExternalSessions('agent', ${options.nativeSession.externalSessionsExport});` : ''}
        }`,
    },
  };
}
