import { describe, expect, it } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import {
  redactTranscriptSecrets,
  registerSessionTranscriptSecret,
  registerTranscriptSecret,
  runInExecutionRunTranscriptSecretScope,
  TRANSCRIPT_SECRET_REDACTED,
} from './transcriptSecretRedaction';

describe('transcript secret redaction', () => {
  it('redacts arbitrary Project secret values inside strings without touching the record structure', () => {
    // Person-chosen values are not base64url: quotes, backslashes and short tokens occur.
    const quoted = registerTranscriptSecret('p@ss"wo\\rd');
    const short = registerTranscriptSecret('1');
    try {
      const content = {
        seq: 1,
        ok: true,
        output: 'token=p@ss"wo\\rd v1 control',
        parts: ['x1y', 2],
      };
      expect(redactTranscriptSecrets(content)).toEqual({
        seq: 1,
        ok: true,
        output: `token=${TRANSCRIPT_SECRET_REDACTED} v${TRANSCRIPT_SECRET_REDACTED} control`,
        parts: [`x${TRANSCRIPT_SECRET_REDACTED}y`, 2],
      });
    } finally {
      quoted();
      short();
    }
  });

  it('masks string values only and never rewrites a record key', () => {
    const release = registerTranscriptSecret('postgres');
    try {
      expect(redactTranscriptSecrets({ postgresUrl: 'postgres://made-up-host/db', nested: { postgres: ['use postgres'] } }))
        .toEqual({
          postgresUrl: `${TRANSCRIPT_SECRET_REDACTED}://made-up-host/db`,
          nested: { postgres: [`use ${TRANSCRIPT_SECRET_REDACTED}`] },
        });
    } finally {
      release();
    }
  });

  it('keeps a value redacted until every launch that registered it is released', () => {
    const first = registerTranscriptSecret('shared-project-value');
    const second = registerTranscriptSecret('shared-project-value');
    first();
    expect(redactTranscriptSecrets('echo shared-project-value')).toBe(
      `echo ${TRANSCRIPT_SECRET_REDACTED}`,
    );
    second();
    expect(redactTranscriptSecrets('echo shared-project-value')).toBe(
      'echo shared-project-value',
    );
  });

  it('masks a Session launch secret only in that hosted Session, and a host-minted bearer in every Session', async () => {
    // Two Accounts' Sessions share one session host process with different environments.
    const ownerSecret = 'true';
    const bearer = 'host-minted-bearer-value';
    const releaseBearer = registerTranscriptSecret(bearer);
    let markOwnerRegistered = () => {};
    const ownerRegistered = new Promise<void>(resolve => { markOwnerRegistered = resolve; });
    let releaseOwner = () => {};
    try {
      const [owner, guest] = await Promise.all([
        runAddedHostedSession({ environment: { HAPPIER_TEST_ACCOUNT: 'owner' }, workingDirectory: '/tmp/owner', end: () => {} },
          async () => {
            releaseOwner = registerTranscriptSecret(ownerSecret);
            markOwnerRegistered();
            // The write happens later, from another async continuation of the same Session.
            await new Promise(resolve => setTimeout(resolve, 1));
            return redactTranscriptSecrets({ output: `owner says ${ownerSecret} ${bearer}` });
          }),
        runAddedHostedSession({ environment: { HAPPIER_TEST_ACCOUNT: 'guest' }, workingDirectory: '/tmp/guest', end: () => {} },
          async () => {
            await ownerRegistered;
            // The guest probes a candidate value; it must come back unchanged.
            return redactTranscriptSecrets({ output: `guest probes ${ownerSecret} ${bearer}` });
          }),
      ]);
      expect(owner).toEqual({ output: `owner says ${TRANSCRIPT_SECRET_REDACTED} ${TRANSCRIPT_SECRET_REDACTED}` });
      expect(guest).toEqual({ output: `guest probes ${ownerSecret} ${TRANSCRIPT_SECRET_REDACTED}` });
    } finally {
      releaseOwner();
      releaseBearer();
    }
  });

  it('keeps a detached Run launch secret in that Run for the Run\'s life, never in another Run or the process set', async () => {
    // Two Accounts' detached Runs in one daemon, each with its own store.
    const owner = new Map<string, number>();
    const guest = new Map<string, number>();
    const release = runInExecutionRunTranscriptSecretScope(owner, () => registerSessionTranscriptSecret('1'));
    release(); // the launch ends before the Run decodes its last turn
    const read = (store: Map<string, number>) => runInExecutionRunTranscriptSecretScope(store,
      async () => { await new Promise(resolve => setTimeout(resolve, 1)); return redactTranscriptSecrets({ line: 1, note: 'port 1' }); });
    await expect(read(owner)).resolves.toEqual({ line: 1, note: `port ${TRANSCRIPT_SECRET_REDACTED}` });
    await expect(read(guest)).resolves.toEqual({ line: 1, note: 'port 1' });
    expect(redactTranscriptSecrets('port 1')).toBe('port 1');
    expect(registerSessionTranscriptSecret('outside-any-scope')).toBeTypeOf('function');
    expect(redactTranscriptSecrets('outside-any-scope')).toBe('outside-any-scope');
    owner.clear(); // the bridge empties the store once the Run settled
    await expect(read(owner)).resolves.toEqual({ line: 1, note: 'port 1' });
  });
});
