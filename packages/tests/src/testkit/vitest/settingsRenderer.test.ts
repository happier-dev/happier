import { expect, it } from 'vitest';

import { renderHook } from '../../../../../apps/ui/sources/dev/testkit/hooks/renderHook';
import { useSettingsValues } from '../../../../../apps/ui/sources/sync/store/settingsReadHooks';

it('renders the production settings selector with the composed test renderer', async () => {
  const hook = await renderHook(useSettingsValues, { initialProps: ['experiments'] as const });
  try {
    expect(hook.getCurrent()).toEqual({ experiments: expect.any(Boolean) });
  } finally {
    await hook.unmount();
  }
});
