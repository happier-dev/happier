import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { selectNewSessionAgent } from './selectNewSessionAgent';

describe('selectNewSessionAgent', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it('opens once and selects an asynchronously retained active option instead of a non-actionable duplicate', async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(300);
    await page.setContent(`
      <button data-testid="agent-input-agent-chip">Agent</button>
      <div id="retained" style="pointer-events:none">
        <button data-testid="agent-input-chip-picker.option:codex">Codex retained</button>
      </div>
      <div id="active" hidden></div>
      <script>
        let openCount = 0;
        document.querySelector('[data-testid="agent-input-agent-chip"]').addEventListener('click', () => {
          openCount += 1;
          document.body.dataset.openCount = String(openCount);
          const active = document.querySelector('#active');
          active.hidden = !active.hidden;
          if (!active.hidden && !active.firstChild) {
            queueMicrotask(() => {
              const option = document.createElement('button');
              option.dataset.testid = 'agent-input-chip-picker.option:codex';
              option.textContent = 'Codex active';
              option.addEventListener('click', () => {
                document.body.dataset.selectedAgent = 'codex';
                active.hidden = true;
              });
              active.append(option);
            });
          }
        });
      </script>
    `);

    await selectNewSessionAgent({ page, agentId: 'codex', timeoutMs: 2_000 });

    const state = await page.evaluate(() => ({
      openCount: Number(document.body.dataset.openCount),
      selectedAgent: document.body.dataset.selectedAgent ?? null,
    }));
    expect(state).toEqual({ openCount: 1, selectedAgent: 'codex' });
    await page.close();
  });

  it('selects the canonical agent-prefixed picker option id', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <button data-testid="agent-input-agent-chip">Agent</button>
      <div id="active" hidden>
        <button data-testid="agent-input-chip-picker.option:agent:codex">Codex</button>
      </div>
      <script>
        document.querySelector('[data-testid="agent-input-agent-chip"]').addEventListener('click', () => {
          document.querySelector('#active').hidden = false;
        });
        document.querySelector('[data-testid="agent-input-chip-picker.option:agent:codex"]').addEventListener('click', () => {
          document.body.dataset.selectedAgent = 'codex';
        });
      </script>
    `);

    await selectNewSessionAgent({ page, agentId: 'codex', timeoutMs: 1_000 });

    expect(await page.locator('body').getAttribute('data-selected-agent')).toBe('codex');
    await page.close();
  });

  it('ignores an older retained Codex trigger and selects Codex through the active trigger', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div style="pointer-events:none">
        <button data-testid="agent-input-agent-chip">Codex</button>
      </div>
      <button data-testid="agent-input-agent-chip">Claude</button>
      <div id="active" hidden>
        <button data-testid="agent-input-chip-picker.option:agent:codex">Codex option</button>
      </div>
      <script>
        const triggers = document.querySelectorAll('[data-testid="agent-input-agent-chip"]');
        triggers[1].addEventListener('click', () => {
          document.querySelector('#active').hidden = false;
          document.body.dataset.activeTriggerOpened = 'true';
        });
        document.querySelector('[data-testid="agent-input-chip-picker.option:agent:codex"]').addEventListener('click', () => {
          document.body.dataset.selectedAgent = 'codex';
        });
      </script>
    `);

    await selectNewSessionAgent({ page, agentId: 'codex', timeoutMs: 1_000 });

    expect(await page.locator('body').getAttribute('data-active-trigger-opened')).toBe('true');
    expect(await page.locator('body').getAttribute('data-selected-agent')).toBe('codex');
    await page.close();
  });
});
