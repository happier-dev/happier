import { describe, expect, it } from 'vitest';
import { resolvePluginCommandMetadata } from './pluginCommandMetadata';

describe('Action CLI metadata', () => {
  it('exposes canonical paths and aliases under one Action identity and availability decision', () => {
    const declaration = {
      id: 'read', title: 'Read note', surfaces: ['cli'] as const,
      cli: { path: ['notes', 'read'], aliases: [['note', 'show'], ['notes']], tmux: 'required' as const },
    };
    const projection = resolvePluginCommandMetadata({
      registry: { actions: [
        { pluginId: 'acme.notes', definition: declaration, admittedTarget: { declaration } },
        { pluginId: 'acme.notes', definition: { ...declaration, id: 'hidden' }, admittedTarget: {
          declaration: { ...declaration, id: 'hidden', surfaces: ['ui'] as const },
        } },
      ] },
      reservedRoots: new Set(),
      resolveAvailability: () => ({ outcome: 'visible', code: 'plugin_contribution_available' }),
    });
    expect(projection.commands.map(({ qualifiedId, qualifiedActionId, path, tmux, status }) => ({
      qualifiedId, qualifiedActionId, path, tmux, status,
    }))).toEqual(expect.arrayContaining([
      { qualifiedId: 'acme.notes/read', qualifiedActionId: 'acme.notes/read', path: ['note', 'show'], tmux: 'required', status: 'available' },
      { qualifiedId: 'acme.notes/read', qualifiedActionId: 'acme.notes/read', path: ['notes'], tmux: 'required', status: 'available' },
      { qualifiedId: 'acme.notes/read', qualifiedActionId: 'acme.notes/read', path: ['notes', 'read'], tmux: 'required', status: 'available' },
    ]));
    expect(projection.commands).toHaveLength(3);
  });

  it('fences a colliding alias without removing the Action canonical path', () => {
    const declarations = [
      { id: 'read', title: 'Read', surfaces: ['cli'], cli: { path: ['notes', 'read'], aliases: [['shared', 'read']] } },
      { id: 'other', title: 'Other', surfaces: ['cli'], cli: { path: ['shared', 'read'] } },
    ];
    const projection = resolvePluginCommandMetadata({
      registry: { actions: declarations.map(declaration => ({
        pluginId: 'acme.notes', definition: { id: declaration.id }, admittedTarget: { declaration },
      })) },
      reservedRoots: new Set(),
      resolveAvailability: () => ({ outcome: 'visible', code: 'plugin_contribution_available' }),
    });
    expect(projection.commands.find(command => command.path.join(' ') === 'notes read')).toMatchObject({ status: 'available' });
    expect(projection.commands.filter(command => command.path.join(' ') === 'shared read'))
      .toEqual([expect.objectContaining({ status: 'ambiguous' }), expect.objectContaining({ status: 'ambiguous' })]);
  });
});
