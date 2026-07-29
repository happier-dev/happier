import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

const binaryWorkflowPath = new URL(
  '../../.github/workflows/publish-cli-binaries.yml',
  import.meta.url,
);
const npmWorkflowPath = new URL(
  '../../.github/workflows/release-npm.yml',
  import.meta.url,
);

function findStep(job, name) {
  return job?.steps?.find((step) => step.name === name);
}

function assertPayloadAdmissionStep(step, expectedChannelExpression) {
  assert.ok(step, 'expected Qualified V4 payload publication admission step');
  assert.equal(step.env?.RELEASE_CHANNEL, expectedChannelExpression);
  const source = String(step.run ?? '');
  assert.match(
    source,
    /stable\) deploy_environment="production"[\s\S]*preview\|dev\) deploy_environment="preview"/,
  );
  assert.match(
    source,
    /deploy\/\$\{deploy_environment\}\/server/,
  );
  assert.match(
    source,
    /qualified-connected-accounts-v4-activation-admission\.mjs[\s\S]*--admission-kind payload-publication/,
  );
  assert.match(source, /--baseline-ref "\$baseline_ref"/);
}

test('CLI binary source and immutable retry publication use deployed-server payload admission', async () => {
  const workflow = YAML.parse(await readFile(binaryWorkflowPath, 'utf8'));
  const prepare = workflow.jobs?.prepare;
  const publish = workflow.jobs?.publish;
  const promoteExisting = workflow.jobs?.promote_existing;

  const prepareAdmission = findStep(
    prepare,
    'Admit Qualified V4 CLI payload publication',
  );
  assertPayloadAdmissionStep(prepareAdmission, '${{ inputs.channel }}');
  assert.ok(
    prepare.steps.indexOf(prepareAdmission)
      > prepare.steps.findIndex((step) => step.name === 'Checkout exact source'),
    'source publication admission must inspect the exact checked-out candidate',
  );
  assert.ok(
    prepare.steps.indexOf(prepareAdmission)
      < prepare.steps.findIndex((step) => step.name === 'Allocate one release version for the native matrix'),
    'source publication admission must precede artifact construction',
  );

  const finalAdmission = findStep(
    publish,
    'Re-admit Qualified V4 CLI payload publication',
  );
  assertPayloadAdmissionStep(finalAdmission, '${{ inputs.channel }}');
  assert.ok(
    publish.steps.indexOf(finalAdmission)
      > publish.steps.findIndex((step) => step.name === 'Create GitHub App token'),
  );
  assert.ok(
    publish.steps.indexOf(finalAdmission)
      < publish.steps.findIndex((step) => step.name === 'Sign manifests and publish prepared CLI matrix'),
    'the deployed-server baseline must be re-read immediately before external publication',
  );

  const retryAdmission = findStep(
    promoteExisting,
    'Admit Qualified V4 immutable CLI payload publication',
  );
  assertPayloadAdmissionStep(retryAdmission, '${{ inputs.channel }}');
  const retrySource = String(retryAdmission.run ?? '');
  assert.match(
    retrySource,
    /git fetch --no-tags --depth=1 origin "\$AUTHORIZED_SHA"[\s\S]*git update-ref refs\/qualified-v4-payload-candidate FETCH_HEAD/,
  );
  assert.match(
    retrySource,
    /--candidate-ref refs\/qualified-v4-payload-candidate/,
  );
  assert.ok(
    promoteExisting.steps.indexOf(retryAdmission)
      > promoteExisting.steps.findIndex((step) => step.name === 'Bind exact immutable tag SHA'),
  );
  assert.ok(
    promoteExisting.steps.indexOf(retryAdmission)
      < promoteExisting.steps.findIndex((step) => step.name === 'Recover rolling projection from immutable bytes'),
  );
});

test('npm CLI publication uses the matching deployed server baseline before packing and publishing', async () => {
  const workflow = YAML.parse(await readFile(npmWorkflowPath, 'utf8'));
  const release = workflow.jobs?.release;
  const publishCli = workflow.jobs?.['publish-cli'];
  const admission = findStep(
    release,
    'Admit Qualified V4 npm CLI payload publication',
  );
  assertPayloadAdmissionStep(admission, '${{ inputs.channel }}');
  assert.equal(admission.if, 'inputs.publish_cli');
  assert.ok(
    release.steps.indexOf(admission)
      > release.steps.findIndex((step) => step.name === 'Checkout source ref'),
  );
  assert.ok(
    release.steps.indexOf(admission)
      < release.steps.findIndex((step) => step.name === 'npm pack (pipeline)'),
  );

  const finalAdmission = findStep(
    publishCli,
    'Re-admit Qualified V4 npm CLI payload publication',
  );
  assertPayloadAdmissionStep(finalAdmission, '${{ inputs.channel }}');
  const finalSource = String(finalAdmission.run ?? '');
  assert.match(
    finalSource,
    /git fetch --no-tags --depth=1 origin "\$CANDIDATE_SHA"[\s\S]*git update-ref refs\/qualified-v4-payload-candidate FETCH_HEAD/,
  );
  assert.match(
    finalSource,
    /--candidate-ref refs\/qualified-v4-payload-candidate/,
  );
  assert.ok(
    publishCli.steps.indexOf(finalAdmission)
      < publishCli.steps.findIndex((step) => step.name === 'npm publish (cli tarball) (pipeline)'),
    'the deployed-server baseline must be re-read immediately before npm publication',
  );
});
