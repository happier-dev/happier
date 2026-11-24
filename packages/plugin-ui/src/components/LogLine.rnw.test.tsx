import { describe, expect, it } from 'vitest';

import { LogLine, Text } from '@happier-dev/plugin-ui';
import { tokenizeAnsiText } from '../ansi.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

describe('LogLine', () => {
  it('shows source metadata and preserves both terminal Find matches and literal structured messages', () => {
    const context = createSurfaceContext();
    const native = tokenizeAnsiText('\u001b[31mListening\u001b[0m');
    const structured = 'query \u001b[31m <b>done</b>';
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <LogLine
          testID="native"
          prefix={<Text value="4" />}
          message={{
            plainText: native.plainText,
            tokens: native.tokens,
            ranges: [{ start: 0, end: native.plainText.length, current: true }],
          }}
        />
        <LogLine
          testID="otlp"
          prefix={<Text value="billing-api" />}
          message={{ plainText: structured }}
        />
      </PluginUiProvider>,
    );
    try {
      const nativeLine = mount.container.querySelector('[data-testid="native"]')!;
      expect(nativeLine.textContent).toBe('4Listening');
      expect(nativeLine.querySelector('[data-testid="find-match-current"]')?.textContent).toBe('Listening');
      const otlpLine = mount.container.querySelector('[data-testid="otlp"]')!;
      expect(otlpLine.textContent).toBe(`billing-api${structured}`);
      expect(otlpLine.querySelector('b')).toBeNull();
    } finally {
      mount.unmount();
    }
  });
});
