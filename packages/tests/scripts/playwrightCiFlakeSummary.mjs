// @ts-check
import { appendFile } from 'node:fs/promises';

/** @param {string} title */
function escapeTitle(title) {
  return title.replace(/\s+/gu, ' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** @implements {import('@playwright/test/reporter').Reporter} */
export default class PlaywrightCiFlakeSummary {
  /** @type {import('@playwright/test/reporter').Suite | undefined} */
  suite;

  /** @type {NonNullable<import('@playwright/test/reporter').Reporter['onBegin']>} */
  onBegin(_config, suite) {
    this.suite = suite;
  }

  async onEnd() {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath || !this.suite) return;

    const flaky = this.suite.allTests().filter(test => test.outcome() === 'flaky');
    const lines = ['', `Flaky tests (passed on retry): **${flaky.length}**`, ''];
    for (const test of flaky) {
      const title = test.titlePath().filter(Boolean).join(' › ');
      lines.push(`- <code>${escapeTitle(title)}</code>`);
    }
    await appendFile(summaryPath, `${lines.join('\n')}\n`);
  }

  printsToStdio() {
    return false;
  }
}
