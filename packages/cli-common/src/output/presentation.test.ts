import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { createTerminalPresentation, createTerminalStyles } from './presentation';

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('createTerminalPresentation', () => {
  it('formats banners, bullets, section titles, and definition lists', () => {
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 3;
    const presentation = createTerminalPresentation(colorChalk);

    const banner = presentation.banner('setup', { subtitle: 'Guided setup', prefix: '✨', suffix: '✨' });
    expect(banner).toContain('\u001B[');
    expect(stripAnsi(banner)).toBe('✨ setup ✨\nGuided setup');

    expect(stripAnsi(presentation.sectionTitle('Plan'))).toBe('Plan');
    expect(stripAnsi(presentation.cmd('happier auth login'))).toBe('happier auth login');
    expect(stripAnsi(presentation.bullets(['one', null, 'two']))).toBe('- one\n- two');

    const definitionList = presentation.definitionList([
      { label: 'Relay', value: 'https://relay.example.test' },
      { label: 'Machine ID', value: 'machine-123' },
    ]);
    expect(definitionList).toContain('\u001B[');
    expect(stripAnsi(definitionList)).toContain('Relay:');
    expect(stripAnsi(definitionList)).toContain('Machine ID:');
  });

  it('formats status lines and error frames with stable structure', () => {
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 3;
    const presentation = createTerminalPresentation(colorChalk);

    expect(stripAnsi(presentation.ok('Ready'))).toBe('✓ Ready');
    expect(stripAnsi(presentation.warn('Needs attention'))).toBe('! Needs attention');
    expect(stripAnsi(presentation.fail('Failed'))).toBe('x Failed');

    const errorFrame = presentation.errorFrame('Error:', ['First detail', 'Second detail']);
    expect(stripAnsi(errorFrame)).toBe('Error:\n  First detail\n  Second detail');
  });
});

describe('createTerminalStyles', () => {
  it('exposes consistent style helpers that respect ansi availability', () => {
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 3;
    const styles = createTerminalStyles(colorChalk);

    expect(styles.ansiEnabled()).toBe(true);
    expect(styles.bold('hello')).toContain('\u001B[');
    expect(stripAnsi(styles.bold('hello'))).toBe('hello');
    expect(stripAnsi(styles.gray('muted'))).toBe('muted');

    const noColorChalk = Object.create(chalk) as typeof chalk;
    noColorChalk.level = 0;
    const noColorStyles = createTerminalStyles(noColorChalk);
    expect(noColorStyles.ansiEnabled()).toBe(false);
    expect(noColorStyles.bold('plain')).toBe('plain');
  });
});
