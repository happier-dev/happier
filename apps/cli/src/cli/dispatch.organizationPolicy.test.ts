import { afterEach, expect, it } from 'vitest';
import { configuration } from '@/configuration';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { dispatchCli } from './dispatch';

const originalPolicy = configuration.organizationPolicy;
afterEach(() => { Object.defineProperty(configuration, 'organizationPolicy', { value: originalPolicy }); });

it('keeps help available while showing only the typed organization policy diagnostic', async () => {
  Object.defineProperty(configuration, 'organizationPolicy', { value: { status: 'invalid', error: { path: 'home.url', code: 'invalid_format' } } });
  const output = captureConsoleText();
  try {
    await dispatchCli({ args: ['--help'], rawArgv: ['happier', '--help'], terminalRuntime: null });
    expect(output.text()).toContain('organization_policy_invalid');
    expect(output.text()).toContain('home.url');
    expect(output.text()).toContain('invalid_format');
    expect(output.text()).toMatch(/Usage\b/);
  } finally { output.restore(); }
});
