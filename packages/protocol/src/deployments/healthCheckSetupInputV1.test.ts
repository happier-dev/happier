import { expect, it } from 'vitest';
import { compilePluginJsonSchema } from '../plugins/actions/jsonSchemaValidation.js';
import { isValidPluginJsonSchemaValue } from '../plugins/actions/protocolComposableSchema.js';
import { HealthCheckSourceConfigV1ProtocolSchema, HealthCheckSetupDraftV1ProtocolSchema, HealthCheckSetupInputV1ProtocolSchema } from './healthCheckSourceV1.js';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } from './healthCheckV1.js';

it('uses the five canonical kind input schemas before health setup enrollment', () => {
    const schema = compilePluginJsonSchema(HealthCheckSetupInputV1ProtocolSchema.jsonSchema);
    const source = (localId: string, config: unknown) => ({ v: 1,
        subject: { kind: 'machineService', machineId: 'machine', serviceId: 'service' },
        checks: [{ checkId: localId, kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId }, binding: { kind: 'healthCheck' },
            config, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] });
    for (const [kind, config] of [
        ['http', { endpoint: 'http://127.0.0.1:8080/ready', expectStatus: 200 }],
        ['certificate', { endpoint: 'https://example.test', expectStatus: 200 }],
        ['tcp', { host: '127.0.0.1', port: 8080 }],
        ['dns', { hostname: 'example.test', recordType: 'A' }],
        ['heartbeat', { graceMs: 1000 }],
    ] as const) expect(isValidPluginJsonSchemaValue(schema, source(kind, config)), kind).toBe(true);
    expect(isValidPluginJsonSchemaValue(schema, source('tcp', { host: '127.0.0.1', port: 0 }))).toBe(false);
    expect(isValidPluginJsonSchemaValue(schema, source('dns', { hostname: 'example.test', recordType: 'invalid' }))).toBe(false);
    expect(isValidPluginJsonSchemaValue(schema, source('http', { endpoint: 'http://example.test', expectStatus: 999 }))).toBe(false);
    expect(isValidPluginJsonSchemaValue(schema, source('http', {}))).toBe(false);
    const domainSource = { ...source('http', { keyword: 'ready' }),
        subject: { kind: 'environment', environmentId: 'environment' },
        checks: source('http', { keyword: 'ready' }).checks.map(check => ({ ...check,
            binding: { kind: 'domain', domainId: 'domain', targetLinkId: 'target', condition: 'domain_probe_failed' } })) };
    expect(isValidPluginJsonSchemaValue(schema, domainSource)).toBe(true);
});

it('preserves a prebound watched subject as a partial launch draft until checks are configured', () => {
    const seed = { v: 1, subject: { kind: 'machineService', machineId: 'watched-machine', serviceId: 'service' } };
    expect(HealthCheckSetupDraftV1ProtocolSchema.parse(seed)).toEqual(seed);
    expect(HealthCheckSetupInputV1ProtocolSchema.safeParse(seed).success).toBe(false);
    expect(HealthCheckSetupDraftV1ProtocolSchema.safeParse({ ...seed, checks: [] }).success).toBe(false);
    expect(HealthCheckSetupDraftV1ProtocolSchema.safeParse({ ...seed, monitoringMachineId: 'observer' }).success).toBe(false);
});

it('carries Domain first-configuration intent without making it a saved source or replacing retained checks', () => {
    const draft = { v: 1, subject: { kind: 'environment', environmentId: 'production' },
        domain: { domainId: 'public-domain', targetLinkId: 'serving-target' } };
    expect(HealthCheckSetupDraftV1ProtocolSchema.parse(draft)).toEqual(draft);
    expect(HealthCheckSetupInputV1ProtocolSchema.safeParse(draft).success).toBe(false);
    expect(HealthCheckSetupDraftV1ProtocolSchema.safeParse({ ...draft, domain: { domainId: '' } }).success).toBe(false);
});

it('admits contributed check config for host catalog validation without weakening native kind inputs', () => {
    const check = { checkId: 'monitor', kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'uptime-kuma' },
        binding: { kind: 'healthCheck' }, config: { monitorId: '7' }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 2 };
    const source = { v: 1, subject: { kind: 'machineService', machineId: 'machine', serviceId: 'service' }, checks: [check] };
    const schema = compilePluginJsonSchema(HealthCheckSetupInputV1ProtocolSchema.jsonSchema);
    expect(HealthCheckSetupInputV1ProtocolSchema.safeParse(source).success).toBe(true);
    expect(isValidPluginJsonSchemaValue(schema, source)).toBe(true);
    expect(HealthCheckSetupInputV1ProtocolSchema.safeParse({ ...source, checks: [{ ...check,
        kind: { ...check.kind, localId: 'tcp' }, config: { host: 'host', port: 0 } }] }).success).toBe(false);
});

it('admits one producer per Domain condition so another check cannot clear its failure', () => {
    const binding = { kind: 'domain', domainId: 'domain', targetLinkId: 'target', condition: 'domain_probe_failed' };
    const native = { checkId: 'http', kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'http' },
        binding, config: {}, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 2 };
    const monitor = { ...native, checkId: 'monitor', kind: { pluginId: 'example.health', localId: 'monitor' }, config: { monitorId: 'shop' } };
    const source = { v: 1, subject: { kind: 'environment', environmentId: 'production' }, checks: [native, monitor] };
    for (const schema of [HealthCheckSetupInputV1ProtocolSchema, HealthCheckSourceConfigV1ProtocolSchema]) {
        expect(schema.safeParse(source).success).toBe(false);
        expect(schema.safeParse({ ...source, checks: [native, { ...monitor,
            binding: { ...binding, condition: 'certificate_renewal_failed' } }] }).success).toBe(true);
        expect(schema.safeParse({ ...source, checks: [native, { ...monitor,
            binding: { ...binding, domainId: 'other-domain' } }] }).success).toBe(true);
    }
});
