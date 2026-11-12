// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import {
  createPluginUiActionControlTestHost,
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { TriageAdministerActionInputV1 } from '../../actions/actionsCatalogProtocol.js';
import {
  TRIAGE_SEEDED_ACTIONS_V1,
  type TriageActionsReadV1,
} from '../../settings/actions.js';
import { TRIAGE_UNREAD_ACTIONS_V1 } from './actionsCommand.js';
import { TriageActionsEditor } from './ActionsEditor.js';
import type { TriageMountedActionsV1 } from './useTriageActions.js';

/**
 * The list a person manages their actions in: turning a built-in off in place, restoring the shipped
 * set in one press, and a loading or unavailable read that never reads as "no actions".
 */

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SEEDED: TriageActionsReadV1 = {
  kind: 'absent',
  value: TRIAGE_SEEDED_ACTIONS_V1,
};
const CONFIGURED: TriageActionsReadV1 = {
  kind: 'parsed',
  value: TRIAGE_SEEDED_ACTIONS_V1,
};

function mountedActions(
  overrides: Partial<TriageMountedActionsV1>,
  administered: TriageAdministerActionInputV1[],
): TriageMountedActionsV1 {
  const read = overrides.read ?? SEEDED;
  return Object.freeze({
    read,
    revision: 'revision-1',
    actions: read.value.actions,
    loaded: true,
    busy: false,
    notice: null,
    unavailableReason: null,
    retry() {},
    async resolveForExecution() {
      return { status: 'unavailable' as const };
    },
    prepareAdminister(input: TriageAdministerActionInputV1) { administered.push(input); return { input }; },
    async settleAdminister() { return null; },
    async administer(input: TriageAdministerActionInputV1) {
      administered.push(input);
      return null;
    },
    ...overrides,
  });
}

const mounted: PluginUiTestkit[] = [];
const controls = new WeakMap<PluginUiTestkit, ReturnType<typeof createPluginUiActionControlTestHost>>();

async function mountEditor(
  actions: TriageMountedActionsV1,
  initialActionId?: string,
): Promise<PluginUiTestkit> {
  const surface = defineUiSurface(() => (
    <TriageActionsEditor actions={actions} {...(initialActionId === undefined ? {} : { initialActionId })} />
  ));
  const host = createPluginUiActionControlTestHost(async () => ({ ok: true, result: { status: 'conflict' } }));
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        instanceId: 'fixture-instance-r16',
        mountNonce: 'fixture-mount-r16',
      },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture({}),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        actionControl: host.handler,
        executeAction: async () => {
          throw new Error('No daemon is reachable from this mount.');
        },
      },
    });
  });
  mounted.push(fixture);
  controls.set(fixture, host);
  await act(async () => {
    await Promise.resolve();
  });
  return fixture;
}

function bodyText(): string {
  return document.body.textContent ?? '';
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the configured-action list', () => {
  it('turns a built-in off from its own row, at the revision it was read at', async () => {
    const administered: TriageAdministerActionInputV1[] = [];
    const editor = await mountEditor(mountedActions({}, administered));
    const ask = TRIAGE_SEEDED_ACTIONS_V1.actions[0]!;

    await act(async () => {
      await editor.press(
        await editor.getByRole('switch', { name: ask.label }),
      );
    });

    expect(administered).toHaveLength(1);
    expect(administered[0]).toMatchObject({
      v: 1,
      kind: 'update',
      actionId: ask.actionId,
      enabled: false,
      expectedRevision: 'revision-1',
      label: ask.label,
      appliesTo: ask.appliesTo,
    });
  });

  it('restores the shipped defaults in one press, without a second step', async () => {
    const administered: TriageAdministerActionInputV1[] = [];
    const editor = await mountEditor(
      mountedActions({ read: CONFIGURED }, administered),
    );

    await act(async () => {
      await controls.get(editor)!.press('Restore');
    });

    expect(administered).toEqual([
      { v: 1, kind: 'reset', expectedRevision: 'revision-1' },
    ]);
  });

  it('has nothing to restore while the catalog is still the shipped one', async () => {
        const administered: TriageAdministerActionInputV1[] = [];
        const editor = await mountEditor(mountedActions({ read: SEEDED }, administered));
        expect(controls.get(editor)?.presentation('Restore')?.disabled).toBe(true);
        expect(administered).toEqual([]);
    });

    it('says it is loading, not that there are no actions, until the first read answers', async () => {
    const administered: TriageAdministerActionInputV1[] = [];
    await mountEditor(
      mountedActions(
        {
          read: TRIAGE_UNREAD_ACTIONS_V1,
          revision: null,
          loaded: false,
        },
        administered,
      ),
    );

    expect(bodyText()).not.toContain('No actions');
    expect(bodyText()).toContain('Loading actions');
  });

  it('explains an unreachable Account and offers Retry, never an empty catalog or an Add', async () => {
    const administered: TriageAdministerActionInputV1[] = [];
    let retried = 0;
    const editor = await mountEditor(
      mountedActions(
        {
          read: TRIAGE_UNREAD_ACTIONS_V1,
          revision: null,
          loaded: false,
          unavailableReason:
            'Happier cannot reach your account right now, so actions cannot be changed.',
          retry() {
            retried += 1;
          },
        },
        administered,
      ),
    );

    expect(bodyText()).toContain('Happier cannot reach your account right now');
    expect(bodyText()).not.toContain('No actions');
    await act(async () => {
      await editor.press(await editor.getByRole('button', { name: 'Retry' }));
    });
    expect(retried).toBe(1);
    expect(
      Array.from(document.querySelectorAll('[role="button"]')).some(
        (node) =>
          node.textContent?.includes('Add an action') &&
          node.getAttribute('aria-disabled') !== 'true',
      ),
    ).toBe(false);
  });

  it('opens straight on the action it was asked to edit (Edit action… from an entry)', async () => {
    const administered: TriageAdministerActionInputV1[] = [];
    const action = TRIAGE_SEEDED_ACTIONS_V1.actions[1]!;
    const editor = await mountEditor(mountedActions({ read: CONFIGURED }, administered), action.actionId);

    expect(controls.get(editor)?.presentation('Save')).toBeDefined();
    const values = Array.from(document.querySelectorAll<HTMLInputElement>('input')).map((input) => input.value);
    expect(values).toContain(action.label);
  });
});
