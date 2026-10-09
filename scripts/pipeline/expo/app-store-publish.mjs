import { ascListAll, buildAscBaseUrl, resolveAscBuildIdentity } from './asc-api.mjs';

function stateOf(version) {
  return String(version?.attributes?.appVersionState ?? version?.attributes?.appStoreState ?? '').trim();
}

function statusOf(version) {
  const state = stateOf(version);
  if (['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(state)) return version?.attributes?.downloadable === false ? 'action_required' : 'published';
  if (state === 'WAITING_FOR_REVIEW') return 'waiting_for_review';
  if (state === 'IN_REVIEW') return 'in_review';
  if (['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'].includes(state)) return 'rejected';
  if (['PENDING_APPLE_RELEASE', 'PROCESSING_FOR_APP_STORE', 'PROCESSING_FOR_DISTRIBUTION', 'ACCEPTED'].includes(state)) return 'pending_release';
  return 'action_required';
}

// Current Apple production review schema (2026-10-09): /v1/reviewSubmissions,
// /v1/reviewSubmissionItems, PATCH submitted=true. Beta review is independent.
// The caller owns release-note source/build binding; this owner preserves its text.
export async function publishAppStoreVersion({ request, ascAppId, appVersion, buildNumber, whatsNew, locale = 'en-US' }) {
  if (![ascAppId, appVersion, buildNumber, locale].every((value) => typeof value === 'string' && value.trim())) {
    throw new Error('App Store publication requires app id, marketing version, exact build number and locale.');
  }
  if (typeof whatsNew !== 'string' || !whatsNew.trim() || [...whatsNew].length > 4000) {
    throw new Error('App Store publication requires bound What’s New text of at most 4000 characters.');
  }
  const build = await resolveAscBuildIdentity({ request, ascAppId, appVersion, buildNumber, platform: 'IOS' });
  if (!build) return { status: 'uploaded', appVersion, buildNumber };
  const buildId = build.id;
  const processingState = build.attributes?.processingState;
  if (['FAILED', 'INVALID'].includes(processingState)) throw Object.assign(new Error(`App Store Connect build ${buildId} processing failed (${processingState}).`), { code: 'ASC_BUILD_PROCESSING_FAILED' });
  if (processingState !== 'VALID') return { status: 'processing', buildId, processingState, appVersion, buildNumber };

  const versionsUrl = new URL(buildAscBaseUrl(`/v1/apps/${encodeURIComponent(ascAppId)}/appStoreVersions`));
  versionsUrl.searchParams.set('filter[platform]', 'IOS');
  versionsUrl.searchParams.set('filter[versionString]', appVersion);
  versionsUrl.searchParams.set('include', 'build');
  const versions = (await ascListAll({ request, url: versionsUrl.toString() }))
    .filter((row) => row.attributes?.platform === 'IOS' && row.attributes?.versionString === appVersion);
  if (versions.length > 1) throw new Error(`Multiple iOS App Store versions match ${appVersion}.`);
  let version = versions[0];
  if (!version) {
    version = (await request({ method: 'POST', url: buildAscBaseUrl('/v1/appStoreVersions'), body: { data: {
      type: 'appStoreVersions',
      attributes: { platform: 'IOS', versionString: appVersion, releaseType: 'AFTER_APPROVAL', reviewType: 'APP_STORE' },
      relationships: { app: { data: { type: 'apps', id: ascAppId } } },
    } } })).data;
  }
  if (!version?.id) throw new Error('App Store Connect did not return an App Store version id.');
  const versionId = version.id;
  const versionUrl = buildAscBaseUrl(`/v1/appStoreVersions/${encodeURIComponent(versionId)}`);
  const editable = ['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'DEVELOPER_REJECTED'].includes(stateOf(version));
  const released = ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(stateOf(version));
  const attachedBuildId = version.relationships?.build?.data?.id;
  if (!editable && attachedBuildId !== buildId) throw new Error(`App Store version ${versionId} references a different build from ${buildId}.`);
  if (!editable && version.attributes?.reviewType === 'NOTARIZATION') throw new Error(`App Store version ${versionId} is not submitted for App Store review.`);
  if (editable && attachedBuildId !== buildId) {
    await request({ method: 'PATCH', url: `${versionUrl}/relationships/build`, body: { data: { type: 'builds', id: buildId } } });
  }
  const localizations = await ascListAll({ request, url: `${versionUrl}/appStoreVersionLocalizations` });
  const localization = localizations.find((row) => row.attributes?.locale === locale);
  if (!localization && !editable) throw new Error(`App Store version ${versionId} has no ${locale} release notes.`);
  if (localization && localization.attributes?.whatsNew !== whatsNew && !editable) {
    throw new Error(`App Store version ${versionId} release notes differ from the bound projection.`);
  }
  if ((!released && version.attributes?.releaseType !== 'AFTER_APPROVAL') || (editable && version.attributes?.reviewType === 'NOTARIZATION')) {
    await request({ method: 'PATCH', url: versionUrl, body: { data: { type: 'appStoreVersions', id: versionId, attributes: {
      releaseType: 'AFTER_APPROVAL', ...(editable && version.attributes?.reviewType === 'NOTARIZATION' ? { reviewType: 'APP_STORE' } : {}),
    } } } });
  }
  if (!localization) {
    await request({ method: 'POST', url: buildAscBaseUrl('/v1/appStoreVersionLocalizations'), body: { data: {
      type: 'appStoreVersionLocalizations', attributes: { locale, whatsNew },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
    } } });
  } else if (localization.attributes?.whatsNew !== whatsNew) {
    await request({ method: 'PATCH', url: buildAscBaseUrl(`/v1/appStoreVersionLocalizations/${encodeURIComponent(localization.id)}`), body: { data: {
      type: 'appStoreVersionLocalizations', id: localization.id, attributes: { whatsNew },
    } } });
  }
  let phased;
  try {
    phased = (await request({ url: `${versionUrl}/appStoreVersionPhasedRelease` }))?.data;
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  if (phased?.id && phased.attributes?.phasedReleaseState !== 'COMPLETE') {
    const phasedUrl = buildAscBaseUrl(`/v1/appStoreVersionPhasedReleases/${encodeURIComponent(phased.id)}`);
    if (phased.attributes?.phasedReleaseState === 'INACTIVE') await request({ method: 'DELETE', url: phasedUrl });
    else await request({ method: 'PATCH', url: phasedUrl, body: { data: { type: 'appStoreVersionPhasedReleases', id: phased.id, attributes: { phasedReleaseState: 'COMPLETE' } } } });
  }
  if (!editable) {
    if (stateOf(version) === 'PENDING_DEVELOPER_RELEASE') {
      await request({ method: 'POST', url: buildAscBaseUrl('/v1/appStoreVersionReleaseRequests'), body: { data: {
        type: 'appStoreVersionReleaseRequests', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      } } });
    }
    version = (await request({ url: `${versionUrl}?include=build` })).data;
    if (version?.relationships?.build?.data?.id !== buildId) throw new Error(`App Store version ${versionId} no longer references build ${buildId}.`);
    return { status: stateOf(version) === 'PENDING_DEVELOPER_RELEASE' ? 'pending_release' : statusOf(version), appStoreState: stateOf(version), versionId, buildId };
  }

  const submissionsUrl = new URL(buildAscBaseUrl('/v1/reviewSubmissions'));
  submissionsUrl.searchParams.set('filter[app]', ascAppId);
  submissionsUrl.searchParams.set('filter[platform]', 'IOS');
  const submissions = await ascListAll({ request, url: submissionsUrl.toString() });
  let submission;
  let hasItem = false;
  for (const candidate of submissions) {
    const items = await ascListAll({ request, url: buildAscBaseUrl(`/v1/reviewSubmissions/${encodeURIComponent(candidate.id)}/items?include=appStoreVersion`) });
    if (items.some((row) => row.relationships?.appStoreVersion?.data?.id === versionId)) {
      submission = candidate; hasItem = true; break;
    }
    if (!submission && candidate.attributes?.state === 'READY_FOR_REVIEW' && items.length === 0) submission = candidate;
  }
  if (!submission) {
    submission = (await request({ method: 'POST', url: buildAscBaseUrl('/v1/reviewSubmissions'), body: { data: {
      type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: ascAppId } } },
    } } })).data;
  }
  if (!submission?.id) throw new Error('App Store Connect did not return a review submission id.');
  if (!hasItem) {
    await request({ method: 'POST', url: buildAscBaseUrl('/v1/reviewSubmissionItems'), body: { data: {
      type: 'reviewSubmissionItems', relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
      },
    } } });
  }
  if (submission.attributes?.state === 'READY_FOR_REVIEW') {
    submission = (await request({ method: 'PATCH', url: buildAscBaseUrl(`/v1/reviewSubmissions/${encodeURIComponent(submission.id)}`), body: { data: {
      type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true },
    } } })).data;
  }
  version = (await request({ url: `${versionUrl}?include=build` })).data;
  if (version?.relationships?.build?.data?.id !== buildId) throw new Error(`App Store version ${versionId} no longer references build ${buildId}.`);
  const status = statusOf(version);
  return { status: status === 'action_required' && submission?.attributes?.state === 'WAITING_FOR_REVIEW' ? 'waiting_for_review' : status,
    appStoreState: stateOf(version), versionId, buildId, reviewSubmissionId: submission?.id, reviewState: submission?.attributes?.state };
}
