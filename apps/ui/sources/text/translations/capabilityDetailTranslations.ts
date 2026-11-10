// Capability detail grammar copy (P5 U5.6/U5.7): words shared by every capability detail page.
// Mounted under `capabilities.detail`.

export type CapabilityDetailTranslation = Readonly<{
  /** A segmented value that follows a default, announced after its label ("Ask, default"). */
  inheritedValue: string;
  onYourMachines: string;
  byMachine: string;
  noMachines: string;
  /** The folded tail of a long machine list ("12 more machines"). */
  moreMachines: (params: Readonly<{ count: number }>) => string;
  /** A scan failed because the machine did not answer: the cause in plain words. */
  scanUnreachable: string;
  /** A listing's closing sections (Versions · Source and licence), in Add and the Store pane alike. */
  listing: Readonly<{
    versionsTitle: string;
    sourceTitle: string; sourceOnlyTitle: string;
    /** The listed version is the one its registry offers now. */
    current: string;
    currentIn: (params: Readonly<{ source: string }>) => string;
  }>;
}>;

const en: CapabilityDetailTranslation = { inheritedValue: 'default', onYourMachines: 'On your machines', byMachine: 'By machine', noMachines: 'No machines yet', moreMachines: ({ count }) => `${count} more ${count === 1 ? 'machine' : 'machines'}`, scanUnreachable: 'It didn’t answer, or the connection dropped before it did.' , listing: { versionsTitle: 'Versions', sourceTitle: 'Source and licence', sourceOnlyTitle: 'Source', current: 'Current', currentIn: ({ source }) => `Current in ${source}` } };
const ca: CapabilityDetailTranslation = { inheritedValue: 'per defecte', onYourMachines: 'Als teus ordinadors', byMachine: 'Per ordinador', noMachines: 'Encara no hi ha ordinadors', moreMachines: ({ count }) => `${count} ordinadors més`, scanUnreachable: 'No ha respost, o la connexió s’ha interromput abans.' , listing: { versionsTitle: 'Versions', sourceTitle: 'Origen i llicència', sourceOnlyTitle: 'Origen', current: 'Actual', currentIn: ({ source }) => `Actual a ${source}` } };
const de: CapabilityDetailTranslation = { inheritedValue: 'Standard', onYourMachines: 'Auf deinen Rechnern', byMachine: 'Nach Rechner', noMachines: 'Noch keine Rechner', moreMachines: ({ count }) => `${count} weitere Rechner`, scanUnreachable: 'Er hat nicht geantwortet, oder die Verbindung brach vorher ab.' , listing: { versionsTitle: 'Versionen', sourceTitle: 'Quelle und Lizenz', sourceOnlyTitle: 'Quelle', current: 'Aktuell', currentIn: ({ source }) => `Aktuell in ${source}` } };
const es: CapabilityDetailTranslation = { inheritedValue: 'predeterminado', onYourMachines: 'En tus equipos', byMachine: 'Por equipo', noMachines: 'Aún no hay equipos', moreMachines: ({ count }) => `${count} equipos más`, scanUnreachable: 'No respondió, o la conexión se cortó antes de que lo hiciera.' , listing: { versionsTitle: 'Versiones', sourceTitle: 'Origen y licencia', sourceOnlyTitle: 'Origen', current: 'Actual', currentIn: ({ source }) => `Actual en ${source}` } };
const fr: CapabilityDetailTranslation = { inheritedValue: 'par défaut', onYourMachines: 'Sur vos machines', byMachine: 'Par machine', noMachines: 'Aucune machine pour l’instant', moreMachines: ({ count }) => `${count} autres machines`, scanUnreachable: 'Elle n’a pas répondu, ou la connexion s’est coupée avant.' , listing: { versionsTitle: 'Versions', sourceTitle: 'Source et licence', sourceOnlyTitle: 'Source', current: 'Actuelle', currentIn: ({ source }) => `Actuelle dans ${source}` } };
const it: CapabilityDetailTranslation = { inheritedValue: 'predefinito', onYourMachines: 'Sui tuoi computer', byMachine: 'Per computer', noMachines: 'Ancora nessun computer', moreMachines: ({ count }) => `Altri ${count} computer`, scanUnreachable: 'Non ha risposto, oppure la connessione è caduta prima.' , listing: { versionsTitle: 'Versioni', sourceTitle: 'Fonte e licenza', sourceOnlyTitle: 'Fonte', current: 'Attuale', currentIn: ({ source }) => `Attuale in ${source}` } };
const ja: CapabilityDetailTranslation = { inheritedValue: '既定', onYourMachines: 'あなたのマシン', byMachine: 'マシン別', noMachines: 'マシンはまだありません', moreMachines: ({ count }) => `ほか ${count} 台のマシン`, scanUnreachable: '応答がなかったか、応答前に接続が切れました。' , listing: { versionsTitle: 'バージョン', sourceTitle: '提供元とライセンス', sourceOnlyTitle: '提供元', current: '最新', currentIn: ({ source }) => `${source} の最新` } };
const pl: CapabilityDetailTranslation = { inheritedValue: 'domyślnie', onYourMachines: 'Na twoich komputerach', byMachine: 'Według komputera', noMachines: 'Brak komputerów', moreMachines: ({ count }) => `Jeszcze ${count} komputerów`, scanUnreachable: 'Nie odpowiedział lub połączenie zostało przerwane przed odpowiedzią.' , listing: { versionsTitle: 'Wersje', sourceTitle: 'Źródło i licencja', sourceOnlyTitle: 'Źródło', current: 'Aktualna', currentIn: ({ source }) => `Aktualna w ${source}` } };
const pt: CapabilityDetailTranslation = { inheritedValue: 'padrão', onYourMachines: 'Nas suas máquinas', byMachine: 'Por máquina', noMachines: 'Ainda não há máquinas', moreMachines: ({ count }) => `Mais ${count} máquinas`, scanUnreachable: 'Não respondeu, ou a conexão caiu antes disso.' , listing: { versionsTitle: 'Versões', sourceTitle: 'Origem e licença', sourceOnlyTitle: 'Origem', current: 'Atual', currentIn: ({ source }) => `Atual em ${source}` } };
const ru: CapabilityDetailTranslation = { inheritedValue: 'по умолчанию', onYourMachines: 'На ваших компьютерах', byMachine: 'По компьютерам', noMachines: 'Компьютеров пока нет', moreMachines: ({ count }) => `Ещё компьютеров: ${count}`, scanUnreachable: 'Нет ответа, либо соединение оборвалось раньше.' , listing: { versionsTitle: 'Версии', sourceTitle: 'Источник и лицензия', sourceOnlyTitle: 'Источник', current: 'Текущая', currentIn: ({ source }) => `Текущая в ${source}` } };
const zhHans: CapabilityDetailTranslation = { inheritedValue: '默认', onYourMachines: '在你的设备上', byMachine: '按设备', noMachines: '还没有设备', moreMachines: ({ count }) => `另外 ${count} 台设备`, scanUnreachable: '它没有响应，或连接在响应前已断开。' , listing: { versionsTitle: '版本', sourceTitle: '来源和许可证', sourceOnlyTitle: '来源', current: '当前版本', currentIn: ({ source }) => `${source} 中的当前版本` } };
const zhHant: CapabilityDetailTranslation = { inheritedValue: '預設', onYourMachines: '在你的裝置上', byMachine: '依裝置', noMachines: '尚無裝置', moreMachines: ({ count }) => `另外 ${count} 台裝置`, scanUnreachable: '它沒有回應，或連線在回應前已中斷。' , listing: { versionsTitle: '版本', sourceTitle: '來源與授權', sourceOnlyTitle: '來源', current: '目前版本', currentIn: ({ source }) => `${source} 中的目前版本` } };

export const capabilityDetailTranslations = { en, ca, de, es, fr, it, ja, pl, pt, ru, zhHans, zhHant } as const;
