import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/declarationClosureIdentity.test.ts'],
        pool: 'forks',
        poolOptions: {
            forks: {
                isolate: false,
                singleFork: true,
            },
        },
    },
});
