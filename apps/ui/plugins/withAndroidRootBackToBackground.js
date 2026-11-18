const { withMainActivity } = require('@expo/config-plugins');

// Owner ruling 2026-11-18 (P03-BOOT-CUT): BACK at the navigation root moves the task to the
// background like Home, so reopening resumes the running app instead of remounting it.
// React Native calls invokeDefaultOnBackPressed only when JavaScript did not handle BACK.
// The Expo template keeps that on Android R and below but finishes the Activity on S+.
const METHOD = /override fun invokeDefaultOnBackPressed\(\) \{[\s\S]*?\n {2}\}/;
const ROOT_BACK_TO_BACKGROUND = `override fun invokeDefaultOnBackPressed() {
      // Root BACK backgrounds the task like Home (owner ruling 2026-11-18): reopening is a hot resume.
      if (!moveTaskToBack(false)) {
          // For non-root activities, use the default implementation to finish them.
          super.invokeDefaultOnBackPressed()
      }
  }`;

function applyRootBackToBackground(contents) {
  const matches = contents.match(new RegExp(METHOD.source, 'g')) ?? [];
  if (matches.length !== 1) {
    throw new Error('Unrecognized Expo MainActivity template: expected one invokeDefaultOnBackPressed override');
  }
  return contents.replace(METHOD, ROOT_BACK_TO_BACKGROUND);
}

const withAndroidRootBackToBackground = (config) => withMainActivity(config, (activity) => {
  if (activity.modResults.language !== 'kt') {
    throw new Error('withAndroidRootBackToBackground supports the Kotlin MainActivity template only');
  }
  activity.modResults.contents = applyRootBackToBackground(activity.modResults.contents);
  return activity;
});

withAndroidRootBackToBackground.applyRootBackToBackground = applyRootBackToBackground;
module.exports = withAndroidRootBackToBackground;
