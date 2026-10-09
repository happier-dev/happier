import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';

export default defineConfig({ test: { ...resolveVitestWorkers(), environment: 'node' } });
