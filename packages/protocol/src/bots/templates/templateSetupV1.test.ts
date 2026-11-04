import { describe, expect, it } from 'vitest';
import { prepareBotTemplateSetupV1, projectBotTemplateSoftwareFactsV1 } from './templateSetupV1.js';
import { bindBotTemplateMcpDefinitionV1 } from '../../mcp/servers/portableMcpDefinitionV1.js';
import type { BotTemplateContentV1 } from './botTemplateV1.js';

const recipe = { pluginId: 'test.tools', recipeId: 'git', revision: '1' };
const software = { key: 'git', name: 'Git', requirement: 'required' as const, purpose: 'Read changes', skipConsequence: '', recipe };
const needs: BotTemplateContentV1['needs'] = { software: [software], connectedAccounts: [], mcpServers: [] };

describe('recipient template setup', () => {
  it('rejects missing required choices before effects and merges only selected recipe inputs', () => {
    expect(() => prepareBotTemplateSetupV1(needs)).toThrow('missing_values');
    expect(() => prepareBotTemplateSetupV1(needs, { software: [{ key: 'git', selection: { action: 'skip' } }], accounts: [], mcpServers: [] })).toThrow('missing_values');
    const prepared = prepareBotTemplateSetupV1(needs, { software: [{ key: 'git', selection: { action: 'install', inputs: {} } }], accounts: [], mcpServers: [] });
    expect(prepared.machineSetup).toEqual({ items: [{ kind: 'softwareRecipe', selection: { ref: recipe, inputs: {} } }] });
    expect(() => prepareBotTemplateSetupV1(needs, { software: [{ key: 'other', selection: { action: 'install', inputs: {} } }], accounts: [], mcpServers: [] })).toThrow('invalid_request');
  });

  it('keeps unavailable tool observations unknown and reports versions only from found packages', () => {
    expect(projectBotTemplateSoftwareFactsV1([software], null)).toEqual([{ key: 'git', status: 'unknown' }]);
    expect(projectBotTemplateSoftwareFactsV1([software], { version: 1, desiredRevision: 0, status: 'satisfied', recipes: [
      { ref: recipe, status: 'satisfied', steps: [{ stepId: 'package', status: 'satisfied', packages: [{ manager: 'apt', name: 'git', present: true, version: '2.45' }] }] },
    ] })).toEqual([{ key: 'git', status: 'found', versions: ['2.45'] }]);
    expect(projectBotTemplateSoftwareFactsV1([software], { version: 1, desiredRevision: 0, status: 'drifted', recipes: [
      { ref: recipe, status: 'drifted', steps: [] },
    ] })).toEqual([{ key: 'git', status: 'missing' }]);
    expect(projectBotTemplateSoftwareFactsV1([software], null, {
      desiredRevision: 0, sources: [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: { ref: recipe, inputs: {} } }] } }],
      exclusions: [], support: [{ sourceIndex: 0, itemIndex: 0, status: 'satisfied' }], recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: {
        v: 1, basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 },
        steps: [{ id: 'git', kind: 'package', manager: 'apt', packages: [{ name: 'git' }] }], planDigest: 'a'.repeat(64),
        nativeFacts: [{ stepId: 'git', status: 'satisfied', facts: { manager: 'apt', packages: [{ manager: 'apt', name: 'git', present: true, version: '2.46' }] } }],
      } }],
    })).toEqual([{ key: 'git', status: 'found', versions: ['2.46'] }]);
  });

  it('binds recipient MCP secrets as refs without resolving or copying source values', () => {
    const definition = { name: 'example', transport: 'http' as const, env: {},
      remote: { url: { baseUrl: { kind: 'literal' as const, value: 'https://example.com/mcp' }, query: [
        { key: { kind: 'literal' as const, value: 'token' }, value: { kind: 'input' as const, key: 'token' } },
      ] }, headers: { Authorization: { kind: 'input' as const, key: 'token' } } },
      inputs: [{ key: 'token', label: 'Token', purpose: 'Authenticate', secret: true, required: true }] };
    const entry = bindBotTemplateMcpDefinitionV1({ definition, inputs: { token: { t: 'savedSecret', secretId: 'recipient-secret' } }, id: 'new-mcp', nowMs: 1 });
    expect(entry.remote).toMatchObject({ url: 'https://example.com/mcp', headers: { Authorization: { t: 'savedSecret', secretId: 'recipient-secret' } },
      urlTemplate: { t: 'template', template: 'https://example.com/mcp?token={input0}', vars: { input0: { t: 'savedSecret', secretId: 'recipient-secret' } } } });
    expect(() => bindBotTemplateMcpDefinitionV1({ definition, inputs: { token: { t: 'literal', v: 'secret-value' } }, id: 'new-mcp', nowMs: 1 })).toThrow('invalid_request');
  });
  it('binds a recipient stdio folder through the existing path carrier', () => {
    expect(bindBotTemplateMcpDefinitionV1({ definition: { name: 'local', transport: 'stdio', env: {},
      stdio: { command: { kind: 'literal', value: 'mcp-tool' }, args: [], cwd: { kind: 'input', key: 'folder' } },
      inputs: [{ key: 'folder', label: 'Folder', purpose: 'Working folder', secret: false, required: true }],
    }, inputs: { folder: { t: 'literal', v: 'C:\\work\\bot' } }, id: 'local', nowMs: 1 }).stdio?.cwd)
      .toEqual({ t: 'path', path: 'C:\\work\\bot' });
  });
});
