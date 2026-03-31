import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStepPrinter } from './progress';

describe('createStepPrinter', () => {
  const writeSpy = vi.spyOn(process.stdout, 'write');

  afterEach(() => {
    writeSpy.mockReset();
  });

  it('prints compact non-tty step lines', () => {
    writeSpy.mockImplementation(() => true);

    const printer = createStepPrinter({ enabled: true });
    printer.start('Installing');
    printer.stop('✓', 'Installing');

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('- [..] Installing');
    expect(output).toContain('- [✓] Installing');
  });
});
