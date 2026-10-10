import 'tsx';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Register after tsx so workspace aliases are mapped before its normal loading
// and transpilation. Preload this leaf before linking a source-tool entry.
register('./sourceRuntimeEntries.mjs', import.meta.url, {
  data: fileURLToPath(new URL('../../', import.meta.url)),
});
