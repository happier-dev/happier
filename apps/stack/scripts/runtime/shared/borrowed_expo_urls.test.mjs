import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBorrowedExpoUiUrl, buildBorrowedExpoWebappUrl } from './borrowed_expo_urls.mjs';

test('borrowed Expo auth URL preserves the consumer origin without browser bootstrap parameters', () => {
  const input = { consumerHost: 'happier-qa.localhost', expoPort: 19364, serverPort: 43005 };
  const webappUrl = buildBorrowedExpoWebappUrl(input);
  assert.equal(webappUrl, 'http://happier-qa.localhost:19364');
  const browserUrl = new URL(buildBorrowedExpoUiUrl(input));
  assert.equal(browserUrl.origin, webappUrl);
  assert.equal(browserUrl.searchParams.get('server'), 'http://happier-qa.localhost:43005');
  assert.equal(browserUrl.searchParams.get('happier_hmr'), '0');
});

test('origin selection needs only Expo while browser launch still requires its server port', () => {
  assert.equal(buildBorrowedExpoWebappUrl({ consumerHost: 'happier-qa.localhost', expoPort: 19364 }),
    'http://happier-qa.localhost:19364');
  assert.equal(buildBorrowedExpoUiUrl({ consumerHost: 'happier-qa.localhost', expoPort: 19364 }), null);
  assert.equal(buildBorrowedExpoWebappUrl({ consumerHost: '', expoPort: 19364 }), null);
  assert.equal(buildBorrowedExpoWebappUrl({ consumerHost: 'happier-qa.localhost', expoPort: 0 }), null);
  const browserUrl = new URL(buildBorrowedExpoUiUrl({ consumerHost: ' LOCALHOST ', expoPort: 19364, serverPort: 43005 }));
  assert.equal(browserUrl.searchParams.get('server'), 'http://LOCALHOST:43005');
});
