import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const uiModules = resolve(repositoryRoot, 'apps/ui/node_modules');

async function bundleFixture() {
  const bundle = await build({
    stdin: {
      resolveDir: resolve(repositoryRoot, 'packages/plugin-ui'),
      sourcefile: 'fieldBox.browser.fixture.tsx',
      loader: 'tsx',
      contents: `
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Pressable, Text, TextInput, View } from 'react-native';
        import { HappierFieldTextBox } from './src/presentation/form/FieldBox.tsx';
        const colors = { borderColor: '#999', backgroundColor: '#fff' };
        function Form() {
          const [port, setPort] = useState('587');
          return <>
            <div id="normal" style={{ width: 320 }}>
              <HappierFieldTextBox colors={colors}><TextInput testID="normal-field" value="Draft" /></HappierFieldTextBox>
            </div>
            <div id="paired" style={{ width: 320 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <HappierFieldTextBox colors={colors} style={{ width: 88 }}>
                  <TextInput testID="port" value={port} onChangeText={setPort} />
                </HappierFieldTextBox>
                <Pressable testID="security" style={{ width: 132 }}><Text>TLS / STARTTLS</Text></Pressable>
              </View>
            </div>
          </>;
        }
        createRoot(document.getElementById('root')).render(<Form />);
        window.checkFieldBoxes = async () => {
          const port = document.querySelector('[data-testid="port"]');
          const security = document.querySelector('[data-testid="security"]');
          for (const width of [320, 240, 320]) {
            for (const id of ['normal', 'paired']) document.getElementById(id).style.width = width + 'px';
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const row = document.getElementById('paired').getBoundingClientRect();
            const choice = security.getBoundingClientRect();
            const field = port.getBoundingClientRect();
            if (field.left < row.left || field.right > row.right || choice.right > row.right) {
              throw new Error('Paired field hides its security control: choice right ' + choice.right + ', row right ' + row.right);
            }
            const normal = document.querySelector('[data-testid="normal-field"]').parentElement.parentElement;
            if (Math.abs(normal.getBoundingClientRect().width - width) > 1) throw new Error('Ordinary stacked field no longer spans its slot');
          }
          return { pairedControlVisible: true, normalFieldSpansSlot: true };
        };
      `,
    },
    bundle: true,
    write: false,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: {
      react: resolve(uiModules, 'react'),
      'react-dom': resolve(uiModules, 'react-dom'),
      'react-native': resolve(uiModules, 'react-native-web'),
    },
  });
  return bundle.outputFiles[0].text;
}

// The shared QA lane consumes this source fixture on its existing CDP browser;
// emitting a bundle does not start a second browser or change its shared stack.
if (process.argv.includes('--bundle-only')) {
  console.log('FIELD_BOX_BUNDLE ' + Buffer.from(await bundleFixture()).toString('base64'));
} else {
  const { default: test } = await import('node:test');
  test('compact fields keep adjacent controls visible while ordinary fields keep spanning their slot', async () => {
    const content = await bundleFixture();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content });
      await page.getByTestId('port').waitFor();
      assert.deepEqual(await page.evaluate(() => window.checkFieldBoxes()), {
        pairedControlVisible: true, normalFieldSpansSlot: true,
      });
    } finally {
      await browser.close();
    }
  });
}
