import {
  HappierRequesterDisclosureContent,
  type HappierRequesterDisclosureModel,
} from '@happier-dev/plugin-ui/components';

/** The author resolves and formats the facts before presenting them. */
export function RequesterDisclosureExample(props: Readonly<{ onLearnMore: () => void }>) {
  const model = {
    title: 'Runs on Ben’s build-01',
    description: 'Your sign-in lasts until this Run finishes. Ben can read the files.',
    learnMore: { label: 'How sharing works', onPress: props.onLearnMore },
  } satisfies HappierRequesterDisclosureModel;
  return <HappierRequesterDisclosureContent model={model} />;
}
