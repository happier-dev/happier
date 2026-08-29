import { applyAndVerifyPersonalHomeSignupClosure, assertPersonalHomeSignupClosed } from '../personalHomeSignupPolicy.js';
import { createPersonalHomeRuntimeSpec, renderPersonalHomeRuntimeEnv, type PersonalHomeRuntimeSpec } from './personalHomeRuntimeSpec.js';

export type PersonalHomeBootstrapResult = Readonly<{
    canonicalServerUrl: string;
    port: number;
    credentials: Readonly<{ token: string; secret: string }>;
}>;

export type PersonalHomeBootstrapDeps = Readonly<{
    bindLoopback: () => Promise<void>;
    resolveNonCollidingPort: () => Promise<number>;
    readPersistedPort: () => Promise<number | null>;
    persistPort: (port: number) => Promise<void>;
    createLocalAccount: (input: Readonly<{ endpoint: string; spec: PersonalHomeRuntimeSpec }>) => Promise<Readonly<{ token: string; secret: string }>>;
    readManagedEnv: () => Promise<string>;
    writeManagedEnv: (text: string) => Promise<void>;
    restartHome: () => Promise<void>;
    readEffectivePolicy: () => Promise<string>;
    readListenerOrigin: () => Promise<string>;
    exposeCarrier?: () => Promise<void>;
}>;

/** Executes the loopback-first Personal Home sequence. Every side effect is supplied by an existing owner. */
export async function runPersonalHomeBootstrap(deps: PersonalHomeBootstrapDeps): Promise<PersonalHomeBootstrapResult> {
    await deps.bindLoopback();
    const persistedPort = await deps.readPersistedPort();
    const port = persistedPort ?? await deps.resolveNonCollidingPort();
    if (persistedPort == null) await deps.persistPort(port);
    const canonicalServerUrl = `http://127.0.0.1:${port}`;
    const spec = createPersonalHomeRuntimeSpec({ canonicalServerUrl });
    const initialEnv = await deps.readManagedEnv();
    const bootstrapEnv = renderPersonalHomeRuntimeEnv({ spec, port, anonymousSignupEnabled: true });
    await deps.writeManagedEnv(`${initialEnv.trimEnd()}\n${Object.entries(bootstrapEnv).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
    const credentials = await deps.createLocalAccount({ endpoint: canonicalServerUrl, spec });
    const closedEnv = applyAndVerifyPersonalHomeSignupClosure(await deps.readManagedEnv());
    await deps.writeManagedEnv(closedEnv);
    await deps.restartHome();
    assertPersonalHomeSignupClosed(await deps.readManagedEnv());
    if ((await deps.readEffectivePolicy()).trim() !== '0') {
        throw new Error('Personal Home signup closure readback is not disabled');
    }
    const listenerOrigin = (await deps.readListenerOrigin()).replace(/\/+$/u, '');
    if (listenerOrigin !== canonicalServerUrl) throw new Error('Personal Home listener origin drifted from its canonical URL');
    if (deps.exposeCarrier) await deps.exposeCarrier();
    return { canonicalServerUrl, port, credentials };
}
