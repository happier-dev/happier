import { gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Complete real AArch64 ELF shared objects, generated on Linux with GCC 13.3:
// int fixture_value(void) { return 16; }
// gcc -nostdlib -shared -s -Wl,--build-id=none,-z,max-page-size=SIZE,-z,common-page-size=SIZE fixture.c -o fixture.so
// Gzip/base64 keeps these sparse compiled fixtures reviewable and portable.
const fixtures = {
  '4k': 'H4sIAAAAAAAAA+1YTWsTURQ982EItlApFQJFm4VCxeZ1+oH4sQkEddOFDXTTTZgm006gk8jkjaQu1J/Qn+JOly78Aa5cd1PIH1Aqgk9mem/Tec1UQXBR3lnk5L77zrvvvplZnPf26cYz27LAcPAB4wioEx/eOD/2ECXUMY2pbO41FKNu5xm0TqorAfBmTmNvIc9fkGfW2X/QvUeey8QvjmXH5QUm8Bzy7BJvHstO6ZL+dPAxNane3/bHZ27Tfz6fFFVrnO/++Ll8Wf103ixcnJCA+8dudyiTOGi98veTIC30rvnJaX215p0nc6Q7UUotaX1Yr5twh7et+emFbKwC4LNSqjyhtoGBgYGBgYGBgYGBwVXCt1+qn/Ih+Sv2viOK2bN9pPg6xWQDMUVc+S+7HfvNIjxvNB5XF7d2kp5MqitrYk14tQdJFq6+WV0X3rpYuUcJQAzCgYylvwOx10tE6A9CiM5Bb3AQnbKMIWQwlBBB2NqN/ShohZ14HGWz/Kjbhtjry+xHvNyXEO1+FAU9+c/9puf7Xak+23t+Tsx3aJzzuo+9SWtwnp8js0fjDnlm1vPzvEU51vN7wczvAcPS4rua92cff8HPE1wtvk96rl90z1Gkf6TpK3aeF7X5+n4atHeH4rN7D2qc72UcTc/3DRtUn/NHpD+amVyvrPGmph+RfkR6/bvT9duk97R5vMGaNmxNYAcXUSN9u0DP+A2ThbsukBMAAA==',
  '16k': 'H4sIAAAAAAAAA+3cS2sTURQH8DMPQ7AFRVoIFDULhYrmOn1QfCwaCOqmCxtw4yZMk2kT6CQyuSNpF9aP0I/iTpcu/ACuXHdTyBdQKoIjMz3HOLeZKghd/X+LnNzHmTt3Jlmee/Bk46ltWSQcek+TFlGd42H9z74HVKI6zdJMNvcSFavb+SgXTPNKROStn7a9g3z8TPkoefZf8t5RPpY5Pj/WHVcuMCXOUT66HDePdad0zv5MVzk2eb1/3Z88c5u/y/NJVa3JeO/7j/vnrZ/Ou0YunXCC7J+2eyMdR0Hrtb8bB+lCb5sfndYXa8F5PMd5J0mS3DP2Ye03yR3dsBZmb2Z9FSL6lCRJecraAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF+nrz2SQxkOur5ba9zG3pWb7A7cvc/sKxxmOlQu520m9eZFnjcaj6uKLrbiv4+rSilpRXm0tzprLb5ZXlbeqlu7wAJEadoc60v4WqZ1+rLr+sEuqs9cf7oWnUUekdDDSpIJuazvyw6DV7USTVjbLD3ttUjsDnX2oV7uaVHsQhkFf//d+0+f7LUkGUt4v70niLe6XcbOOfZ6vIePyHiV63O9wzbzky/u8zmOSL78LifI7EJbRvm3U/ksd/5l6fuYa7bucL+sXnXNQlP/QyK/Y+bhozDfvp8H37nD797kHfA6CnMvgGPly3sAGry/jR5x/tD59vbIRN438MeePOd/835n5LznfM+bJ+RM1o9uaEh06q8b57YJ88QtAU5azkEMAAA==',
};

export function androidElfFixture(alignment = '16k') {
  return gunzipSync(Buffer.from(fixtures[alignment], 'base64'));
}

export function createAndroidAabFixture(directory, { alignment = '16k', aabPath = path.join(directory, 'fixture.aab') } = {}) {
  fs.mkdirSync(path.join(directory, 'base/lib/arm64-v8a'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'base/manifest'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'base/lib/arm64-v8a/libfixture.so'), androidElfFixture(alignment));
  // AAPT2 XmlNode: package dev.happier.app, versionCode4242, versionName1.2.3.
  fs.writeFileSync(path.join(directory, 'base/manifest/AndroidManifest.xml'), Buffer.from('CqkBGghtYW5pZmVzdCIaEgdwYWNrYWdlGg9kZXYuaGFwcGllci5hcHAiPwoqaHR0cDovL3NjaGVtYXMuYW5kcm9pZC5jb20vYXBrL3Jlcy9hbmRyb2lkEgt2ZXJzaW9uQ29kZRoENDI0MiJACipodHRwOi8vc2NoZW1hcy5hbmRyb2lkLmNvbS9hcGsvcmVzL2FuZHJvaWQSC3ZlcnNpb25OYW1lGgUxLjIuMw==', 'base64'));
  fs.writeFileSync(path.join(directory, 'BundleConfig.pb'), Buffer.from('1206120408011002', 'hex'));
  execFileSync('zip', ['-qr', aabPath, 'base', 'BundleConfig.pb'], { cwd: directory });
  return aabPath;
}
