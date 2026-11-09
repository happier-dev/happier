// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { resolveNewSessionDockPaneElement } from './newSessionDockPane';

describe('the docked New Session seat', () => {
  afterEach(() => { document.body.replaceChildren(); });
  // Layout is the DOM boundary: each column reports where the shell drew it.
  const column = (testId: string, left: number, width: number) => {
    const element = document.createElement('div');
    element.setAttribute('data-testid', testId);
    element.getBoundingClientRect = () => ({ x: left, left, width, right: left + width, y: 0, top: 0, height: 800, bottom: 800, toJSON: () => ({}) });
    return element;
  };
  const page = () => {
    const list = column('multi-pane-main-column', 56, 466);
    const detail = column('multi-pane-details-docked', 522, 750);
    const sidebar = document.createElement('nav');
    const ask = document.createElement('button');
    const newFromSidebar = document.createElement('button');
    detail.append(ask);
    sidebar.append(newFromSidebar);
    document.body.append(sidebar, list, detail);
    return { list, detail, ask, newFromSidebar };
  };

  it('seats in the pane column that holds the control that opened it', () => {
    const shell = page();
    expect(resolveNewSessionDockPaneElement(shell.ask)).toBe(shell.detail);
  });

  it('keeps the page main column when the opener is outside every pane, or there is none', () => {
    const shell = page();
    expect(resolveNewSessionDockPaneElement(shell.newFromSidebar)).toBe(shell.list);
    expect(resolveNewSessionDockPaneElement(null)).toBe(shell.list);
  });
});
