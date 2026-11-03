import { describe, expect, it } from 'vitest';
import { parseOrganizationPolicyV1 } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { resolveServerSelection } from './serverSelection';

const input = { envServerUrl: null, envLocalServerUrl: null, envPublicServerUrl: null, envWebappUrl: null, envActiveServerId: null, persisted: null, serversDir: '/unused' };
const organizationPolicy = (locked: boolean) => parseOrganizationPolicyV1(JSON.stringify({ schemaVersion: 1, organization: 'Example', home: { url: 'https://company.example', locked } }));
describe('organization Home selection', () => {
  it('uses a policy default only without an explicit choice', () => {
    expect(resolveServerSelection({ ...input, organizationPolicy: organizationPolicy(false) }).serverUrl).toBe('https://company.example');
    expect(resolveServerSelection({ ...input, organizationPolicy: organizationPolicy(false), envServerUrl: 'https://mine.example' }).serverUrl).toBe('https://mine.example');
  });
  it('a locked Home overrides all process route and profile overrides', () => {
    expect(resolveServerSelection({ ...input, organizationPolicy: organizationPolicy(true), envServerUrl: 'https://mine.example', envPublicServerUrl: 'https://public.example', envLocalServerUrl: 'http://127.0.0.1:9999', envWebappUrl: 'https://app.example', envActiveServerId: 'mine', persisted: { activeServerId: 'mine', servers: { mine: { id: 'mine', serverUrl: 'https://mine.example', webappUrl: 'https://app.example' } } } })).toMatchObject({ serverUrl: 'https://company.example', apiServerUrl: 'https://company.example', webappUrl: 'https://company.example' });
  });
  it('removing policy restores the retained user choice; invalid policy keeps existing runtime reads', () => {
    expect(resolveServerSelection({ ...input, organizationPolicy: { status: 'absent' }, envServerUrl: 'https://mine.example' }).serverUrl).toBe('https://mine.example');
    expect(resolveServerSelection({ ...input, organizationPolicy: { status: 'invalid', error: { path: '$', code: 'invalid_json' } }, envServerUrl: 'https://mine.example' }).serverUrl).toBe('https://mine.example');
  });
  it('keeps the matching locked Home profile identity and its credentials namespace', () => {
    const selected = resolveServerSelection({ ...input, organizationPolicy: organizationPolicy(true), persisted: { activeServerId: 'company', servers: { company: { id: 'company', serverUrl: 'https://company.example/', webappUrl: 'https://app.company.example' } } } });
    expect(selected.activeServerId).toBe('company');
    expect(selected.serverUrl).toBe('https://company.example');
  });
});
