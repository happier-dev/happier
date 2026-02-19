import test from 'node:test';
import assert from 'node:assert/strict';

import { rewriteEasLocalBuildArtifactPath } from '../pipeline/expo/rewrite-eas-local-build-artifact-path.mjs';

test('rewriteEasLocalBuildArtifactPath rewrites dagger-exported metadata to point at the host artifact path', () => {
  const raw = JSON.stringify(
    {
      mode: 'local',
      platform: 'android',
      profile: 'preview-apk',
      artifactPath: '/tmp/happier-ui-mobile-android.apk',
    },
    null,
    2,
  );

  const rewritten = rewriteEasLocalBuildArtifactPath({
    rawJson: raw,
    artifactPath: '/Users/leeroy/Documents/Development/happier/dev/dist/ui-mobile/happier-preview.apk',
  });

  const parsed = JSON.parse(rewritten);
  assert.equal(parsed.mode, 'local');
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.profile, 'preview-apk');
  assert.equal(parsed.artifactPath, '/Users/leeroy/Documents/Development/happier/dev/dist/ui-mobile/happier-preview.apk');
});

