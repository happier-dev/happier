import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// QA-only fault replay. The canonical owner stays unchanged on disk and in live Expo.
// Set R9_TAIL_MISWIRE=1 to remove the destination Home from the real Run pane.
export default mergeConfig(base, defineConfig({
    plugins: [{
        name: 'r9-tail-run-home-sensitivity',
        enforce: 'pre',
        transform(source, id) {
            if (process.env.R9_TAIL_MISWIRE !== '1'
                || !id.split('?')[0]!.replaceAll('\\', '/').endsWith('/components/workflows/run/WorkflowRunPane.tsx')) return;
            const binding = 'const { runId, invocationId, serverId } = props;';
            if (!source.includes(binding)) throw new Error('R9 sensitivity target changed; no fault was injected');
            return { code: source.replace(binding,
                'const { runId, invocationId } = props; const serverId = null;'), map: null };
        },
    }],
}));
