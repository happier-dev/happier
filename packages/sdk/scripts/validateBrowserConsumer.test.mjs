import test from 'node:test';
import { validateBrowserConsumer } from './validateBrowserConsumer.mjs';

test('the current-source browser SDK loads without entering the Action lifetime scenario', async () => {
  await validateBrowserConsumer({ loadOnly: true });
});

test('the current-source public SDK bundles for browsers and executes an Action through fetch', async () => {
  await validateBrowserConsumer();
});
