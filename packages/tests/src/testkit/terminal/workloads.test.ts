import { describe, expect, it } from 'vitest';

import { bytesSha256Hex } from './ansi';
import {
  TERMINAL_WORKLOAD_IDS,
  getTerminalWorkload,
  listTerminalWorkloads,
} from './workloads';

describe('terminal workloads', () => {
  it('lists the complete TERM workload corpus in stable order', () => {
    expect(listTerminalWorkloads().map((workload) => workload.id)).toEqual([
      'ansi-burst',
      'heavy-tui-redraw',
      'alternate-screen',
      'cursor-style-churn',
      'wide-combining',
      'invalid-utf8-binary',
      'bracketed-paste-echo',
      'link-heavy-output',
      'long-scrollback',
    ]);
    expect(TERMINAL_WORKLOAD_IDS).toEqual(listTerminalWorkloads().map((workload) => workload.id));
  });

  it('generates deterministic bytes and checksums for every workload', () => {
    const first = listTerminalWorkloads();
    const second = listTerminalWorkloads();

    expect(first.map((workload) => workload.byteLength)).toEqual(second.map((workload) => workload.byteLength));
    expect(first.map((workload) => bytesSha256Hex(workload.bytes))).toEqual(
      second.map((workload) => bytesSha256Hex(workload.bytes)),
    );
    expect(first.every((workload) => workload.byteLength > 0)).toBe(true);
  });

  it('keeps binary and interaction edge cases explicit in the corpus', () => {
    const binary = getTerminalWorkload('invalid-utf8-binary');
    expect([...binary.bytes]).toEqual(expect.arrayContaining([0x00, 0x80, 0xc0, 0xff]));

    const paste = getTerminalWorkload('bracketed-paste-echo');
    expect(Buffer.from(paste.bytes).toString('utf8')).toContain('\u001b[200~');

    const links = getTerminalWorkload('link-heavy-output');
    expect(Buffer.from(links.bytes).toString('utf8')).toContain('\u001b]8;;https://');
  });
});
