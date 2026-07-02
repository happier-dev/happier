import type { Machine, Session } from '@/sync/domains/state/storageTypes';

import { createMachineFixture } from './machineFixtures';
import { createSessionFixture } from './sessionFixtures';

const DEMO_MACHINE_ID = 'm-macbook-pro';
const DEMO_MACHINE_HOST = 'macbook-pro';
const DEMO_HOME_DIR = '/Users/demo';
const DEMO_PROJECT_PATH = '/Users/demo/code/happier';
const DEMO_SERVER_BASE_URL = 'http://127.0.0.1:4099';
const DEMO_OPEN_CODE_PROVIDER_SESSION_ID = 'sess_opencode_auth';
const DEMO_NOW_MS = Date.parse('2026-04-24T12:00:00.000Z');

export type CreateDemoMachineFixtureOptions = Partial<Machine>;

export function createDemoMachineFixture(options: CreateDemoMachineFixtureOptions = {}): Machine {
    const { metadata: metadataOverrides, ...machineOverrides } = options;

    return createMachineFixture({
        id: DEMO_MACHINE_ID,
        active: true,
        metadata: {
            host: DEMO_MACHINE_HOST,
            platform: 'darwin',
            happyCliVersion: '1.0.0-demo',
            happyHomeDir: `${DEMO_HOME_DIR}/.happy`,
            homeDir: DEMO_HOME_DIR,
            username: 'demo',
            displayName: 'MacBook Pro',
            ...(metadataOverrides ?? {}),
        } as Machine['metadata'],
        ...machineOverrides,
    });
}

export type CreateDemoOpenCodeSessionFixtureOptions = Partial<Session> & Readonly<{
    machineId?: string;
    path?: string;
    title?: string;
    providerSessionId?: string;
    serverBaseUrl?: string;
    nowMs?: number;
}>;

export function createDemoOpenCodeSessionFixture(options: CreateDemoOpenCodeSessionFixtureOptions = {}): Session {
    const {
        machineId = DEMO_MACHINE_ID,
        path = DEMO_PROJECT_PATH,
        title = 'Dashboard auth skeleton',
        providerSessionId = DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
        serverBaseUrl = DEMO_SERVER_BASE_URL,
        nowMs = DEMO_NOW_MS,
        metadata: metadataOverrides,
        ...sessionOverrides
    } = options;
    const runtimeDescriptorV1 = {
        v: 1,
        providerId: 'opencode',
        provider: {
            backendMode: 'server',
            providerSessionId,
            serverBaseUrl,
            serverBaseUrlExplicit: true,
            providerExtra: {
                owner: 'opencode',
                schemaId: 'opencode.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeHandle: {
                    backendMode: 'server',
                    providerSessionId,
                    serverBaseUrl,
                    serverBaseUrlExplicit: true,
                },
            },
        },
    } as const;

    return createSessionFixture({
        id: 's-opencode-auth',
        createdAt: nowMs - 30_000,
        updatedAt: nowMs,
        active: true,
        activeAt: nowMs,
        presence: 'online',
        thinking: true,
        thinkingAt: nowMs,
        metadata: {
            path,
            host: DEMO_MACHINE_HOST,
            homeDir: DEMO_HOME_DIR,
            name: title,
            machineId,
            summary: { text: title, updatedAt: nowMs },
            opencodeSessionId: providerSessionId,
            opencodeBackendMode: 'server',
            opencodeServerBaseUrl: serverBaseUrl,
            opencodeServerBaseUrlExplicit: true,
            runtimeDescriptorV1,
            ...(metadataOverrides ?? {}),
        } as Session['metadata'],
        ...sessionOverrides,
    });
}
