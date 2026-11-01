import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { packageSelection } from './packageSelection.js';

const version: PluginJsonSchema = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9.,+:~_@-]*$' };
function packages(properties: Record<string, PluginJsonSchema>, required: string[]): PluginJsonSchema {
  return { type: 'array', minItems: 1, items: { type: 'object', properties: { ...properties, version }, required, additionalProperties: false } };
}

const nativeIdentities = {
  apt: { name: { type: 'string', pattern: '^[a-z0-9][a-z0-9+.-]*$' } },
  dnf: { name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9+_.-]*$' } },
  brew: { name: { type: 'string', pattern: '^[a-z0-9][a-z0-9+_.@-]*(/[a-z0-9][a-z0-9+_.@-]*/[a-z0-9][a-z0-9+_.@-]*)?$' },
    kind: { type: 'string', enum: ['formula', 'cask'] } },
  winget: { name: { type: 'string', pattern: '^([A-Za-z0-9]+|[A-Za-z0-9][A-Za-z0-9_+-]*(\\.[A-Za-z0-9][A-Za-z0-9_+-]*)+)$' },
    source: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }, scope: { type: 'string', enum: ['user', 'machine'] } },
} satisfies Record<string, Record<string, PluginJsonSchema>>;
const managers = ['apt', 'dnf', 'brew', 'winget'] as const;
const managerIdentities = Object.fromEntries(managers.map(manager => [manager, {
  type: 'object', properties: { ...nativeIdentities[manager], version },
  required: manager === 'brew' ? ['name', 'kind'] : ['name'], additionalProperties: false,
} satisfies PluginJsonSchema]));
function draftIdentity(properties: Record<string, PluginJsonSchema>): PluginJsonSchema {
  return { type: 'object', properties: Object.fromEntries(Object.entries({ ...properties, version }).map(([key, schema]) => [key, {
    type: 'string', ...(schema.enum ? { enum: schema.enum } : {}),
  }])), additionalProperties: false };
}
const managerDrafts = Object.fromEntries(managers.map(manager => [manager, draftIdentity(nativeIdentities[manager])]));
const legacySelection = packageSelection({ apt: { kind: 'input', path: 'apt' }, dnf: { kind: 'input', path: 'dnf' },
  brew: { kind: 'input', path: 'brew' }, winget: { kind: 'input', path: 'winget' } }, true);
const explicitPackages = (state: 'present' | 'absent'): MachineRecipeV1['steps'] => managers.map(manager => ({
  id: `package-${manager}`, kind: 'package', manager, state,
  packages: [{ kind: 'input', path: `package.${manager}` }],
  when: [{ input: { op: 'eq', path: 'package.manager', value: manager } }],
}));

/** Exact reviewed native identities only; no search, manager installation or shell. */
export const installPackage: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Install a package by name', software: true, icon: 'download',
  description: 'Install exact native package ids using the first available supplied manager: apt, dnf, Homebrew, then WinGet. '
    + 'Optional versions are exact pins. Missing sources, unavailable pins and insufficient authority require a remedy; another manager is never substituted. '
    + 'The package form uses the explicitly selected manager. Removal removes only these packages and preserves dependencies and user data.',
  inputSchema: {
    type: 'object', properties: {
      apt: packages(nativeIdentities.apt, ['name']),
      dnf: packages(nativeIdentities.dnf, ['name']),
      brew: packages(nativeIdentities.brew, ['name', 'kind']),
      winget: packages(nativeIdentities.winget, ['name', 'source', 'scope']),
      package: { oneOf: managers.map(manager => ({ type: 'object', properties: {
        manager: { type: 'string', enum: [manager] }, ...managerDrafts, [manager]: managerIdentities[manager]!,
      }, required: ['manager', manager], additionalProperties: false })) },
    },
    oneOf: [{ required: ['package'] }, { anyOf: managers.map(manager => ({ required: [manager] })) }],
    additionalProperties: false,
  },
  inputHints: { fields: [
    { path: 'package.manager', title: 'Package manager', widget: 'select', required: true,
      options: [{ value: 'apt', label: 'APT' }, { value: 'dnf', label: 'DNF' },
        { value: 'brew', label: 'Homebrew' }, { value: 'winget', label: 'WinGet' }] },
    ...managers.flatMap(manager => [
      { path: `package.${manager}.name`, title: 'Package name', widget: 'text' as const, required: true,
        visibleWhen: { op: 'eq' as const, path: 'package.manager', value: manager } },
      { path: `package.${manager}.version`, title: 'Exact version', widget: 'text' as const,
        visibleWhen: { op: 'eq' as const, path: 'package.manager', value: manager } },
    ]),
    { path: 'package.brew.kind', title: 'Homebrew package kind', widget: 'select', required: true,
      visibleWhen: { op: 'eq', path: 'package.manager', value: 'brew' },
      options: [{ value: 'formula', label: 'Formula' }, { value: 'cask', label: 'Cask' }] },
    { path: 'package.winget.source', title: 'WinGet source', widget: 'text',
      visibleWhen: { op: 'eq', path: 'package.manager', value: 'winget' } },
    { path: 'package.winget.scope', title: 'WinGet scope', widget: 'select',
      visibleWhen: { op: 'eq', path: 'package.manager', value: 'winget' },
      options: [{ value: 'user', label: 'User' }, { value: 'machine', label: 'Machine' }] },
  ] },
  checks: legacySelection.checks,
  steps: [...legacySelection.steps, ...explicitPackages('present')],
  removeSteps: [...legacySelection.removeSteps ?? [], ...explicitPackages('absent')],
};
