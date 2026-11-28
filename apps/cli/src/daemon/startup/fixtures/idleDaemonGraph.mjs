import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Observe actual module loading in a fresh process. No daemon, plugin, schema,
// or archive implementation is replaced by the harness.
const archiveModules = new Set();
const htmlParserModules = new Set();
let machineSecurityLoaded = false;
registerHooks({
    load(url, context, nextLoad) {
        if (url.includes('/node_modules/@zip.js/zip.js/')) archiveModules.add(url);
        if (url.includes('/node_modules/parse5/')) htmlParserModules.add(url);
        if (url.endsWith('/machines/security/projectMachineSecurity.ts')) machineSecurityLoaded = true;
        return nextLoad(url, context);
    },
});

await import('../../startDaemon.ts');
const idleArchiveModules = archiveModules.size;
const idleHtmlParserModules = htmlParserModules.size;
const idleMachineSecurity = machineSecurityLoaded;

// Demand the real canonical archive owner to prove both the observer and the
// deferred producer/consumer remain reachable after daemon startup imports.
const { exportSkillBundlesAsZipV1, readSkillZipFilesV1 } = await import(
    '../../../../../../packages/protocol/src/prompts/library/skills/skillZipV1.ts'
);
const { decodeBase64 } = await import('../../../../../../packages/protocol/src/crypto/base64.ts');
const archive = await exportSkillBundlesAsZipV1([{
    name: 'idle-graph',
    files: [{ path: 'SKILL.md', contentBase64: 'eA==', contentKind: 'utf8' }],
}]);
const files = await readSkillZipFilesV1(decodeBase64(archive.bytes));
assert.equal(files[0]?.contentBase64, 'eA==');
assert(archiveModules.size > 0, 'Archive demand did not reach the observed ZIP implementation');
const { buildArtifactHtmlDocumentV1 } = await import('../../../../../../packages/protocol/src/artifacts/artifactHtmlDocumentV1.ts');
assert.match(buildArtifactHtmlDocumentV1({
    v: 1,
    entrypoint: 'index.html',
    files: { 'index.html': { mime: 'text/html', contentBase64: 'PGgxPkhlbGxvPC9oMT4=' } },
}), /Hello/);
assert(htmlParserModules.size > 0, 'HTML demand did not reach the observed parser');
const { projectMachineSecurity } = await import('../../../machines/security/projectMachineSecurity.ts');
const security = projectMachineSecurity({
    machineId: 'idle-graph', canManage: false, updates: { status: 'unavailable' },
});
assert.equal(security.grade.kind, 'incomplete');
assert(machineSecurityLoaded, 'Security demand did not reach the daemon projection');
const idleGraphs = [
    ...(idleArchiveModules > 0 ? ['zip-archive'] : []),
    ...(idleHtmlParserModules > 0 ? ['html-parser'] : []),
    ...(idleMachineSecurity ? ['machine-security'] : []),
];
process.stdout.write(`${JSON.stringify({
    idleGraphs,
    demandedArchiveModules: archiveModules.size,
    demandedHtmlParserModules: htmlParserModules.size,
})}\n`);
assert.deepEqual(idleGraphs, [], 'Idle daemon composition loaded optional demand code');
process.exit(0);
