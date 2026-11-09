import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('.', import.meta.url));
await build({ entryPoints: [root + 'ui/Journey.tsx'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  outfile: root + '.happier-plugin/ui/hosted-web/journey/assets/app.js', minify: true,
  alias: { 'react-native': require.resolve('react-native-web'), 'react-native-svg': require.resolve('react-native-svg/lib/module/elements.web.js') } });
