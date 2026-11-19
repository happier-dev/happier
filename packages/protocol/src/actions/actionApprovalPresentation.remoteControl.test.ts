import { describe, expect, it } from 'vitest';

import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { getActionSpec } from './actionSpecs.js';
import { BrowserOpenViewCommandV1Schema } from '../browser/control/v1.js';
import { ComputerAccessV1Schema, ComputerProviderIdV1Schema } from '../computer/v1.js';
import { COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR } from '../installables/definitions/computerCuaDriver.js';
import { COMPUTER_AGENT_DESKTOP_INSTALLABLE_DESCRIPTOR } from '../installables/definitions/computerAgentDesktop.js';

describe('Browser and Computer Action review labels', () => {
  // DESIGN-LOGIC-1119: the approval uses the same named choices as the Action form.
  it.each(['browser.view.open', 'browser.target.set', 'browser.workspace.open'] as const)(
    '%s reads a website and browser location without exposing schema vocabulary', actionId => {
      const spec = getActionSpec(actionId);
      const common = { commandId: 'open-website',
        target: { kind: 'externalUrl', targetId: 'website', url: 'https://example.test/' }, engineOverride: 'managed' };
      const actionArgs = spec.inputSchema.parse(actionId === 'browser.workspace.open'
        ? { ...common, scopeId: 'workspace' }
        : { ...common, browserSessionId: 'browser', viewId: 'page',
          ...(actionId === 'browser.target.set' ? { kind: 'setTarget' } : { kind: 'openView', platform: 'web' }) });
      const { rows, unrepresentable } = describeApprovalActionFields({ actionId, actionArgs });
      expect(unrepresentable).toBeNull();
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'target.kind', title: 'Page type', value: 'Website' }),
        expect.objectContaining({ path: 'target.url', title: 'URL', value: 'https://example.test/' }),
        expect.objectContaining({ path: 'engineOverride', title: 'Open in', value: 'Browser on the Machine' }),
      ]));
      const fields = getActionSpec(actionId).inputHints!.fields;
      expect(fields.find(field => field.path === 'engineOverride')?.options?.map(option => option.value))
        .toEqual(BrowserOpenViewCommandV1Schema.shape.engineOverride._zod.def.innerType.options);
    },
  );

  it('reads every Computer access and driver choice through its declared label', () => {
    const spec = getActionSpec('computer.target.select');
    expect(spec.inputHints?.fields.find(field => field.path === 'access')?.options?.map(option => option.value))
      .toEqual(ComputerAccessV1Schema.options);
    expect(spec.inputHints?.fields.find(field => field.path === 'provider')?.options?.map(option => option.value))
      .toEqual(ComputerProviderIdV1Schema.options);
    const review = describeApprovalActionFields({ actionId: spec.id,
      actionArgs: { machineId: 'machine', requestedTarget: 'Editor', access: 'use', provider: 'cua' } });
    expect(review.unrepresentable).toBeNull();
    expect(review.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'requestedTarget', title: 'Window or app', value: 'Editor' }),
      expect.objectContaining({ path: 'access', title: 'Access', value: 'View and control' }),
      expect.objectContaining({ path: 'provider', title: 'Computer driver', value: COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR.display.name }),
    ]));
  });

  it('keeps clipboard content private while naming the selected Computer driver', () => {
    const review = describeApprovalActionFields({ actionId: 'computer.clipboard.write',
      actionArgs: { machineId: 'machine', provider: 'agent-desktop', text: 'private clipboard content' } });
    expect(review.unrepresentable).toBeNull();
    expect(JSON.stringify(review)).not.toContain('private clipboard content');
    expect(getActionSpec('computer.clipboard.write').inputHints?.fields.find(field => field.path === 'provider')?.options)
      .toContainEqual({ value: 'agent-desktop', label: COMPUTER_AGENT_DESKTOP_INSTALLABLE_DESCRIPTOR.display.name });
  });
});
