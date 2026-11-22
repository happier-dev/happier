import { expect, it } from 'vitest';
import { getActionSpec } from '../actionSpecs.js';
import { buildApprovalPreviewSummary } from '../executor/approvalPreparation.js';

it('says the address host a Browser open or navigate decides, never its path, query or fragment', () => {
  const target = { kind: 'externalUrl', url: 'https://en.wikipedia.org:8443/wiki/Checkout?token=secret#frag' };
  const summaries = {
    workspace: buildApprovalPreviewSummary(getActionSpec('browser.workspace.open'),
      { scopeId: 'cmwrjty5101jq5fmcxz6x1xdc', commandId: 'command-1', target }),
    view: buildApprovalPreviewSummary(getActionSpec('browser.view.open'),
      { kind: 'openView', browserSessionId: 'browser-session-1', commandId: 'command-2', target, platform: 'web' }),
    navigate: buildApprovalPreviewSummary(getActionSpec('browser.navigate'),
      { kind: 'navigate', browserSessionId: 'browser-session-1', viewId: 'view-1', commandId: 'command-3',
        url: 'https://shop.example.com/cart?session=abc' }),
  };
  expect(summaries.workspace).toBe('Open en.wikipedia.org:8443 in the Browser.');
  expect(summaries.view).toBe('Open en.wikipedia.org:8443 in the Browser.');
  expect(summaries.navigate).toBe('Go to shop.example.com in the Browser.');
  for (const summary of Object.values(summaries)) expect(summary).not.toMatch(/\/wiki|Checkout|token|secret|frag|cart|session=/);
});

it('falls back to the title when a Browser open has no readable address', () => {
  const spec = getActionSpec('browser.workspace.open');
  expect(buildApprovalPreviewSummary(spec, { scopeId: 'scope', commandId: 'c', target: { kind: 'localServicePreview', serviceId: 's' } }))
    .toBe(`${spec.title}.`);
  expect(buildApprovalPreviewSummary(spec, { scopeId: 'scope', commandId: 'c', target: { kind: 'externalUrl', url: 'not a url' } }))
    .toBe(`${spec.title}.`);
});

it('keeps workspace routing ids in technical approval facts', () => {
  expect(getActionSpec('browser.workspace.open').approvalPresentation?.technicalInputPaths).toContain('scopeId');
});
