import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { patchIosXcodeProjectsForSigningAndIdentity } from './ios_xcodeproj_patch.mjs';

async function makeTempUiDir() {
  return await mkdtemp(join(tmpdir(), 'hstack-mobile-'));
}

test('patchIosXcodeProjectsForSigningAndIdentity patches legacy ios/Happy.xcodeproj + ios/Happy/Info.plist', async () => {
  const uiDir = await makeTempUiDir();
  try {
    const iosDir = join(uiDir, 'ios');
    await mkdir(join(iosDir, 'Happy.xcodeproj'), { recursive: true });
    await mkdir(join(iosDir, 'Happy'), { recursive: true });

    const pbxprojPath = join(iosDir, 'Happy.xcodeproj', 'project.pbxproj');
    await writeFile(
      pbxprojPath,
      [
        'ProvisioningStyle = Automatic;',
        'DEVELOPMENT_TEAM = 3RSYVV66F6;',
        'CODE_SIGN_IDENTITY = "Apple Development";',
        '"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "iPhone Developer";',
        'PROVISIONING_PROFILE_SPECIFIER = some-profile;',
        'PRODUCT_BUNDLE_IDENTIFIER = dev.happier.app;',
        'PRODUCT_NAME = Happy;',
        '',
      ].join('\n'),
      'utf-8'
    );

    const infoPlistPath = join(iosDir, 'Happy', 'Info.plist');
    await writeFile(
      infoPlistPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0"><dict>',
        '<key>CFBundleDisplayName</key><string>Happy</string>',
        '</dict></plist>',
        '',
      ].join('\n'),
      'utf-8'
    );

    await patchIosXcodeProjectsForSigningAndIdentity({
      uiDir,
      iosBundleId: 'dev.happier.stack.stack.user.pre-pr272',
      iosAppName: 'HAPPY LEGACY',
    });

    const pbxproj = await readFile(pbxprojPath, 'utf-8');
    assert.match(pbxproj, /PRODUCT_BUNDLE_IDENTIFIER = dev\.happier\.stack\.stack\.user\.pre-pr272;/);
    assert.ok(!pbxproj.includes('DEVELOPMENT_TEAM ='));
    assert.ok(!pbxproj.includes('PROVISIONING_PROFILE_SPECIFIER ='));
    assert.ok(!pbxproj.includes('CODE_SIGN_IDENTITY ='));
    assert.match(pbxproj, /PRODUCT_NAME = HAPPY-LEGACY;/);

    const plist = await readFile(infoPlistPath, 'utf-8');
    assert.match(plist, /<key>CFBundleDisplayName<\/key><string>HAPPY LEGACY<\/string>/);
  } finally {
    await rm(uiDir, { recursive: true, force: true });
  }
});

test('patchIosXcodeProjectsForSigningAndIdentity patches both Happydev + Happy projects when present', async () => {
  const uiDir = await makeTempUiDir();
  try {
    const iosDir = join(uiDir, 'ios');

    await mkdir(join(iosDir, 'Happy.xcodeproj'), { recursive: true });
    await mkdir(join(iosDir, 'Happy'), { recursive: true });
    await writeFile(join(iosDir, 'Happy.xcodeproj', 'project.pbxproj'), 'PRODUCT_BUNDLE_IDENTIFIER = dev.happier.app;\n', 'utf-8');
    await writeFile(join(iosDir, 'Happy', 'Info.plist'), '<key>CFBundleDisplayName</key><string>Happy</string>\n', 'utf-8');

    await mkdir(join(iosDir, 'Happydev.xcodeproj'), { recursive: true });
    await mkdir(join(iosDir, 'Happydev'), { recursive: true });
    await writeFile(join(iosDir, 'Happydev.xcodeproj', 'project.pbxproj'), 'PRODUCT_BUNDLE_IDENTIFIER = dev.happier.app.dev;\n', 'utf-8');
    await writeFile(join(iosDir, 'Happydev', 'Info.plist'), '<key>CFBundleDisplayName</key><string>Happy (dev)</string>\n', 'utf-8');

    await patchIosXcodeProjectsForSigningAndIdentity({
      uiDir,
      iosBundleId: 'dev.happier.stack.stack.user.pre-pr272',
      iosAppName: 'HAPPY LEGACY',
    });

    const pbxprojRelease = await readFile(join(iosDir, 'Happy.xcodeproj', 'project.pbxproj'), 'utf-8');
    assert.match(pbxprojRelease, /PRODUCT_BUNDLE_IDENTIFIER = dev\.happier\.stack\.stack\.user\.pre-pr272;/);

    const pbxprojDev = await readFile(join(iosDir, 'Happydev.xcodeproj', 'project.pbxproj'), 'utf-8');
    assert.match(pbxprojDev, /PRODUCT_BUNDLE_IDENTIFIER = dev\.happier\.stack\.stack\.user\.pre-pr272;/);
  } finally {
    await rm(uiDir, { recursive: true, force: true });
  }
});
