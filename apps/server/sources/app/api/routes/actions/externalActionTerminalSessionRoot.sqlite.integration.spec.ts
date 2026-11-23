import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import type { Server } from 'socket.io';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import {
  createExternalActionDaemonDispatcher,
  type ExternalActionForwardRpcCall,
} from '@/app/api/socket/externalActionDispatcher';
import { auth } from '@/app/auth/auth';
import * as externalActionAdmission from '@/app/auth/externalActionExecutionAuthorization';
import * as machineAccess from '@/app/machines/machineAccess';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prisma';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

// Counting instruments only: each wrapper calls the real owner unchanged.
vi.mock(
  '@/app/auth/externalActionExecutionAuthorization',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/app/auth/externalActionExecutionAuthorization')
      >();
    return {
      ...actual,
      resolveExternalActionExecutionMachineAdmissionInTx: vi.fn(
        actual.resolveExternalActionExecutionMachineAdmissionInTx,
      ),
    };
  },
);
vi.mock('@/app/machines/machineAccess', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/machines/machineAccess')>();
  return {
    ...actual,
    readActiveMachineAdmissionInTx: vi.fn(
      actual.readActiveMachineAdmissionInTx,
    ),
  };
});

// COORD-FIX-TERMINAL-HOME-CONTINUATION-1123: a foreign terminal read is admitted once per
// terminal session. Each later page re-presents that root and runs one still-active Machine
// access lookup at Home: no new admission and no mint, but withdrawn access ends at the next page.
let harness: LightSqliteHarness;
beforeAll(async () => {
  harness = await createLightSqliteHarness({
    tempDirPrefix: 'terminal-session-root-',
    initAuth: true,
    env: {
      AUTH_REQUIRED_LOGIN_PROVIDERS: '',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
    },
  });
}, 120_000);
afterAll(async () => {
  await harness?.close();
});

async function createSharedMachine(ownerId: string) {
  return db.machine.create({
    data: {
      id: crypto.randomUUID(),
      accountId: ownerId,
      active: true,
      metadata: encodePlainMachineStoredContent({
        host: 'shared',
        platform: 'linux',
        happyCliVersion: 'test',
        homeDir: '/home/shared',
        happyHomeDir: '/home/shared/.happier',
      }),
      dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
      installationId: crypto.randomUUID(),
      installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey),
      operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: {
        requesterExecutionIsolation: { protocolVersions: [1] },
        externalActionExecutionAuthorization: { protocolVersions: [1] },
      },
    },
  });
}

async function createTerminalHome() {
  const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
  const machine = await createSharedMachine(owner.id);
  // The daemon transport is the system boundary; Home's admission, mint, lookup and relay run for real.
  const forwarded: Array<Readonly<{ machineAdmission?: { role?: string } }>> =
    [];
  const forwardRpc = (async (
    request: Readonly<{ machineAdmission?: { role?: string } }>,
  ) => {
    forwarded.push(request);
    return {
      ok: false,
      error: 'daemon_boundary',
      errorCode: 'daemon_boundary',
    };
  }) as unknown as ExternalActionForwardRpcCall;
  const app = Fastify({ logger: false }) as unknown as AppFastify;
  enableAuthentication(app);
  registerExternalActionRoutes(app, {
    dispatch: createExternalActionDaemonDispatcher({
      io: { to: () => ({ emit: () => undefined }) } as unknown as Server,
      forwardRpc,
    }),
  });
  const serverId = await getOrCreateServerIdentityId();
  const actionId = 'machines.terminal.read';
  const page = (
    byteOffset: number,
    terminalId: string,
    machineId = machine.id,
  ) => ({
    v: 1 as const,
    requestId: crypto.randomUUID(),
    target: { kind: 'machine' as const, machineId },
    input: { serverId, machineId, terminalId, byteOffset },
  });
  const open = async (viewerId: string) => {
    const bearer = await auth.createToken(viewerId, undefined, {
      kind: 'account',
      authority: 'present_user',
    });
    const terminalId = crypto.randomUUID();
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/actions/${actionId}/execution-authorization`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: { v: 1, machineId: machine.id, envelope: page(0, terminalId) },
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const root = ExternalActionExecutionAuthorizationV1Schema.parse(
      issued.json(),
    );
    const present = (
      byteOffset: number,
      options: Readonly<{
        token?: string;
        terminalId?: string;
        machineId?: string;
        authorization?: unknown;
      }> = {},
    ) =>
      app.inject({
        method: 'POST',
        url: `/v1/actions/${actionId}`,
        headers: { authorization: `Bearer ${options.token ?? bearer}` },
        payload: {
          v: 1,
          machineId: options.machineId ?? machine.id,
          executionAuthorization: options.authorization ?? root,
          envelope: page(
            byteOffset,
            options.terminalId ?? terminalId,
            options.machineId,
          ),
        },
      });
    return { root, terminalId, present };
  };
  return { owner, machine, app, forwarded, actionId, open };
}

const admissions = vi.mocked(
  externalActionAdmission.resolveExternalActionExecutionMachineAdmissionInTx,
);
const stillActive = vi.mocked(machineAccess.readActiveMachineAdmissionInTx);

it('admits a foreign terminal read once and runs one still-active lookup per later page', async () => {
  const home = await createTerminalHome();
  const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
  const stranger = await db.account.create({
    data: { encryptionMode: 'plain' },
  });
  const otherMachine = await createSharedMachine(home.owner.id);
  for (const [accountId, machineId] of [
    [viewer.id, home.machine.id],
    [stranger.id, home.machine.id],
    [viewer.id, otherMachine.id],
  ] as const) {
    expect(
      await inTx((tx) =>
        setEligibleMachineAccessGrantInTx(tx, {
          actorAccountId: home.owner.id,
          machineId,
          principal: { kind: 'account', accountId },
          level: 'view',
        }),
      ),
    ).toMatchObject({ kind: 'saved' });
  }
  const mints = vi.spyOn(auth, 'mintExternalActionExecutionAuthorization');
  admissions.mockClear();
  stillActive.mockClear();
  try {
    const session = await home.open(viewer.id);
    expect(session.root.binding).toMatchObject({
      accountId: viewer.id,
      custodianAccountId: home.owner.id,
      machineId: home.machine.id,
      actionId: home.actionId,
      terminalSession: { terminalId: session.terminalId },
    });
    expect({
      admissions: admissions.mock.calls.length,
      mints: mints.mock.calls.length,
    }).toEqual({ admissions: 1, mints: 1 });

    // N = 4 pages, the last a reattach from offset 0: zero admissions or mints after the first.
    for (const offset of [0, 1, 2, 0]) await session.present(offset);
    expect(home.forwarded).toHaveLength(4);
    expect({
      admissions: admissions.mock.calls.length,
      mints: mints.mock.calls.length,
      stillActive: stillActive.mock.calls.length,
    }).toEqual({ admissions: 1, mints: 1, stillActive: 4 });

    // Every refusal is the relay owner's existing typed refusal, before any daemon dispatch.
    const strangerBearer = await auth.createToken(stranger.id, undefined, {
      kind: 'account',
      authority: 'present_user',
    });
    const refusals = [
      await session.present(3, { token: strangerBearer }),
      await session.present(3, { terminalId: crypto.randomUUID() }),
      await session.present(3, { machineId: otherMachine.id }),
      await session.present(3, {
        authorization: {
          ...session.root,
          binding: {
            ...session.root.binding,
            terminalSession: { terminalId: 'other' },
          },
        },
      }),
      await session.present(3, {
        authorization: {
          ...session.root,
          token: `${session.root.token.slice(0, -4)}AAAA`,
        },
      }),
    ];
    for (const refused of refusals)
      expect(refused.json()).toMatchObject({
        error: 'credential_scope_denied',
      });
    expect(home.forwarded).toHaveLength(4);
    expect({
      admissions: admissions.mock.calls.length,
      mints: mints.mock.calls.length,
    }).toEqual({ admissions: 1, mints: 1 });

    // Measured cost of one still-active lookup next to the full admission it replaces.
    const selects: string[] = [];
    const client = await createDbMaintenanceClient('sqlite', undefined, {
      log: [{ emit: 'event', level: 'query' }],
    });
    onDbClientQuery(client, ({ query }) => {
      if (/^SELECT\b/i.test(query.trimStart())) selects.push(query);
    });
    try {
      await client.$transaction((tx) =>
        machineAccess.readActiveMachineAdmissionInTx(tx as never, {
          actorAccountId: viewer.id,
          machineId: home.machine.id,
        }),
      );
      const lookup = selects.length;
      selects.length = 0;
      await client.$transaction((tx) =>
        externalActionAdmission.resolveExternalActionExecutionMachineAdmissionInTx(
          tx as never,
          {
            actorAccountId: viewer.id,
            machineId: home.machine.id,
            actionId: home.actionId,
            carrier: 'select',
            envelope: {
              v: 1,
              target: { kind: 'machine', machineId: home.machine.id },
              input: {},
            },
            authentication: { authenticationAuthority: 'present_user' },
          },
        ),
      );
      console.info('TERMINAL_SESSION_PAGE_SQL', {
        stillActiveLookupSelects: lookup,
        fullAdmissionSelects: selects.length,
      });
      expect(lookup).toBeGreaterThan(0);
    } finally {
      await client.$disconnect();
    }
  } finally {
    mints.mockRestore();
    await home.app.close();
  }
});

it('refuses the next page once the Account grant is removed', async () => {
  const home = await createTerminalHome();
  const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
  await inTx((tx) =>
    setEligibleMachineAccessGrantInTx(tx, {
      actorAccountId: home.owner.id,
      machineId: home.machine.id,
      principal: { kind: 'account', accountId: viewer.id },
      level: 'view',
    }),
  );
  try {
    const session = await home.open(viewer.id);
    await session.present(1);
    expect(home.forwarded).toHaveLength(1);
    await inTx((tx) =>
      machineAccess.removeMachineAccessGrantInTx(tx, {
        actorAccountId: home.owner.id,
        machineId: home.machine.id,
        principal: { kind: 'account', accountId: viewer.id },
      }),
    );
    expect((await session.present(2)).json()).toMatchObject({
      error: 'credential_scope_denied',
    });
    expect(home.forwarded).toHaveLength(1);
  } finally {
    await home.app.close();
  }
});

it('refuses the next page once the Team grant is removed', async () => {
  const home = await createTerminalHome();
  const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
  const team = await db.team.create({ data: { name: 'Terminal viewers' } });
  await db.teamMembership.createMany({
    data: [
      { teamId: team.id, accountId: viewer.id, role: 'member' },
    ],
  });
  await db.machineGrant.create({
    data: {
      principalKind: 'team',
      machineId: home.machine.id,
      teamId: team.id,
      accessLevel: 'view',
      createdByAccountId: home.owner.id,
    },
  });
  try {
    const session = await home.open(viewer.id);
    await session.present(1);
    expect(home.forwarded).toHaveLength(1);
    await inTx((tx) =>
      machineAccess.removeMachineAccessGrantInTx(tx, {
        actorAccountId: home.owner.id,
        machineId: home.machine.id,
        principal: { kind: 'team', teamId: team.id },
      }),
    );
    expect((await session.present(2)).json()).toMatchObject({
      error: 'credential_scope_denied',
    });
    expect(home.forwarded).toHaveLength(1);
  } finally {
    await home.app.close();
  }
});

it('relays the current role after Manage is narrowed to Use', async () => {
  const home = await createTerminalHome();
  const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
  const grant = (level: 'view' | 'admin') =>
    inTx((tx) =>
      setEligibleMachineAccessGrantInTx(tx, {
        actorAccountId: home.owner.id,
        machineId: home.machine.id,
        principal: { kind: 'account', accountId: viewer.id },
        level,
      }),
    );
  await grant('admin');
  try {
    const session = await home.open(viewer.id);
    expect(session.root.binding.admittedMachineRole).toBe('manage');
    await session.present(1);
    expect(home.forwarded.at(-1)?.machineAdmission?.role).toBe('manage');
    await grant('view');
    // The root still says Manage; the next page carries the current Use role, which the
    // Machine refuses for a Machine-kind terminal (rpcHandlers.terminal.ts authorizeTerminal).
    await session.present(2);
    expect(home.forwarded).toHaveLength(2);
    expect(home.forwarded.at(-1)?.machineAdmission?.role).toBe('use');
  } finally {
    await home.app.close();
  }
});
