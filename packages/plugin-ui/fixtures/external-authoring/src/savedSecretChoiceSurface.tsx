import * as React from 'react';
import { SavedSecretChoiceList, type SavedSecretChoiceSelection } from '@happier-dev/plugin-ui/components';

/** The author offers Happier's saved-secret list and keeps only the chosen reference; the host reads the catalog. */
export function SavedSecretChoiceExample() {
  const [chosen, setChosen] = React.useState<SavedSecretChoiceSelection | null>(null);
  return <SavedSecretChoiceList testIDPrefix="author-saved-secret" selectedRef={chosen?.ref ?? null} onSelect={setChosen} />;
}
