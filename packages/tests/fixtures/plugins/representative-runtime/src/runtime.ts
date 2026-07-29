type RepresentativeRuntimeContext = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  exec: Readonly<{
    spawnClient(spec: unknown): Promise<Readonly<{ dispose(reason?: unknown): Promise<void> }>>;
  }>;
  fetch(input: string, init?: unknown): Promise<unknown>;
  actions: Readonly<{
    execute(request: Readonly<{ actionId: string; input?: unknown }>): Promise<unknown>;
  }>;
  subagents: Readonly<{
    run(request: Readonly<{ id: string; prompt: string }>): Promise<unknown>;
  }>;
  secrets: Readonly<{
    get(key: string): Promise<string | null>;
  }>;
}>;

export async function runRepresentativeRuntimeProof(ctx: RepresentativeRuntimeContext): Promise<void> {
  if ((process.env.PATH ?? '') !== '' || (process.env.Path ?? '') !== '') {
    throw new Error('Representative runtime proof must execute in a process with stripped PATH');
  }

  if ((ctx.env.PATH ?? '') !== '' || (ctx.env.Path ?? '') !== '') {
    throw new Error('Representative runtime proof must execute with stripped PATH');
  }

  const token = await ctx.secrets.get('REPRESENTATIVE_RUNTIME_TOKEN');
  await ctx.fetch('https://example.invalid/representative-runtime/proof', {
    method: 'POST',
    body: token === null ? 'missing' : 'present',
  });
  await ctx.actions.execute({
    actionId: 'representative-runtime.echo',
    input: { value: 'ok' },
  });
  await ctx.subagents.run({
    id: 'representative-runtime.audit',
    prompt: 'verify representative runtime services',
  });

  const client = await ctx.exec.spawnClient({
    launch: {
      kind: 'managed-installable',
      installableId: 'representative-runtime.echo-server',
      executableName: 'representative-runtime-echo',
      args: ['--stdio'],
    },
    protocol: { kind: 'json-rpc-2.0' },
    transport: {
      kind: 'stdio',
      framing: { kind: 'strict-lf-json' },
    },
  });
  await client.dispose({ code: 'representative_runtime_fixture_complete' });
}
