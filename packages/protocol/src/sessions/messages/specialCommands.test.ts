import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

import {
  isNonSteerablePromptPayload,
  parseSpecialCommand,
} from './specialCommands.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('special command payload steerability', () => {
  it('classifies only turn-context-mutating commands as non-steerable by default', () => {
    expect(parseSpecialCommand('/clear')).toEqual({ type: 'clear' });
    expect(parseSpecialCommand('/compact focus on this bug')).toEqual({
      type: 'compact',
      originalMessage: '/compact focus on this bug',
    });
    expect(parseSpecialCommand('/compact\tfocus on this bug')).toEqual({
      type: 'compact',
      originalMessage: '/compact\tfocus on this bug',
    });
    expect(parseSpecialCommand('/compact\nfocus on this bug')).toEqual({
      type: 'compact',
      originalMessage: '/compact\nfocus on this bug',
    });
    expect(parseSpecialCommand('/model')).toEqual({ type: null });
    expect(parseSpecialCommand('/permissions')).toEqual({ type: null });

    expect(isNonSteerablePromptPayload('/clear')).toBe(true);
    expect(isNonSteerablePromptPayload('/compact focus on this bug')).toBe(true);
    expect(isNonSteerablePromptPayload('/compact\tfocus on this bug')).toBe(true);
    expect(isNonSteerablePromptPayload('/compact\nfocus on this bug')).toBe(true);
    expect(isNonSteerablePromptPayload('/model')).toBe(false);
    expect(isNonSteerablePromptPayload('/permissions')).toBe(false);
    expect(isNonSteerablePromptPayload('ordinary steering text')).toBe(false);
  });

  it('exports the shared classifier from the protocol root', () => {
    expect(protocol.parseSpecialCommand('/compact')?.type).toBe('compact');
    expect(protocol.isNonSteerablePromptPayload('/model')).toBe(false);
  });

  it.each([
    'apps/ui/sources/sync/domains/session/control/submitMode.ts',
    'apps/cli/src/agent/runtime/permissions/bindModeQueue.ts',
  ])('keeps %s on the shared payload classifier without a local command set', (relativePath) => {
    const source = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');

    expect(source).toContain('isNonSteerablePromptPayload');
    expect(source).not.toContain("'/clear'");
    expect(source).not.toContain("'/compact'");
    expect(source).not.toContain('"/clear"');
    expect(source).not.toContain('"/compact"');
  });

  it('keeps the Claude plugin steer and compact lifecycle gates on the shared payload helpers', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations.ts'), 'utf8');

    expect(source).toContain('isNonSteerablePromptPayload');
    expect(source).toContain('parseSpecialCommand');
    expect(source).not.toContain("startsWith('/')");
    expect(source).not.toContain('startsWith("/")');
  });

  it('keeps the CLI parser as a protocol re-export instead of a second command parser', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'apps/cli/src/cli/parsers/specialCommands.ts'), 'utf8');

    expect(source).toContain("from '@happier-dev/protocol'");
    expect(source).toContain('isNonSteerablePromptPayload');
    expect(source).not.toContain('function parse');
  });

  it('keeps the plugin SDK runtime session surface on the protocol classifier', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'packages/plugin-sdk/src/runtime/session.ts'), 'utf8');

    expect(source).toContain("from '@happier-dev/protocol'");
    expect(source).toContain('isNonSteerablePromptPayload');
    expect(source).not.toContain('function parse');
  });
});
