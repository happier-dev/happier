import type { PluginApi } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { activate } from './activate.js';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 } from './actions/listEntriesProtocol.js';
import {
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
} from './actions/userMarksProtocol.js';
import { TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1 } from './composer/attachmentValue.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function collectRegistrations(): Readonly<{
  actions: readonly string[];
  attachments: readonly Readonly<{ id: string; roles: readonly string[] }>[];
}> {
  const actions: string[] = [];
  const attachments: Readonly<{ id: string; roles: readonly string[] }>[] = [];
  // Only the registration surface is stood in for; activation itself runs.
  const api = {
    actions: { register: (id: string) => { actions.push(id); } },
    composerAttachments: {
      register: (id: string, runtime: Readonly<Record<string, unknown>>) => {
        attachments.push({ id, roles: Object.keys(runtime).filter((key) => runtime[key] !== undefined) });
      },
    },
  } as unknown as PluginApi;

  activate(api);
  return { actions, attachments };
}

describe('Triage activation', () => {
  it('registers exactly the Actions the manifest declares', () => {
    const registered = [...collectRegistrations().actions];

    // An activation that registers nothing leaves the declared Action
    // undispatchable, and an activation that registers something undeclared
    // exposes a contribution the host never admitted. Both fail here.
    expect(registered).toEqual(expect.arrayContaining([
      TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
      TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
      TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    ]));
    expect(PLUGIN_MANIFEST.contributes.actions.map((action) => action.id)).toEqual(registered);
  });

  it('registers a runtime for every attachment lifecycle role the manifest declares', () => {
    const registered = collectRegistrations().attachments;

    // A declared role with no registration is a draft the host asks this plugin
    // to resolve and gets nothing back for; a registered role the manifest never
    // declared is never invoked. Both are silent, so both fail here.
    expect(registered).toEqual(PLUGIN_MANIFEST.contributes.composerAttachments
      .filter((attachment) => attachment.runtime !== undefined)
      .map((attachment) => ({
        id: attachment.id,
        roles: Object.keys(attachment.runtime).filter(
          (role) => attachment.runtime[role as keyof typeof attachment.runtime] === true,
        ),
      })));
    expect(registered).toContainEqual({
      id: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
      roles: ['resolveForDispatch'],
    });
  });
});
