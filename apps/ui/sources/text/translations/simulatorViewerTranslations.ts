import type { SupportedLanguage } from '../_all';

type SimulatorViewerCopy = Readonly<{
  discoveryTitle: string;
  discoveryDescription: string;
  emptyTitle: string;
  emptyBody: string;
  opening: (params: { device: string }) => string;
  connectingVideo: string;
  reconnecting: string;
  takeControlFirst: string;
  tools: string;
  closeTools: string;
  streamSection: string;
  streamDescription: string;
  buttonsSection: string;
  switchDevice: string;
  hideControls: string;
  showControls: string;
  more: string;
}>;

export const simulatorViewerTranslations = {
  en: {
    discoveryTitle: 'Choose a device',
    discoveryDescription: 'Simulators and emulators running on this machine.',
    emptyTitle: 'No simulators running',
    emptyBody:
      'Start an iOS simulator or an Android emulator on this machine. It appears here once it boots.',
    opening: ({ device }: { device: string }) => `Opening ${device}…`,
    connectingVideo: 'Connecting to the screen…',
    reconnecting: 'Reconnecting…',
    takeControlFirst: 'Take control to press device buttons',
    tools: 'Tools',
    closeTools: 'Close tools',
    streamSection: 'Stream',
    streamDescription: 'Lighten the stream on a slow connection.',
    buttonsSection: 'Device buttons',
    switchDevice: 'Switch device',
    hideControls: 'Hide controls',
    showControls: 'Show controls',
    more: 'More',
  },
  fr: {
    discoveryTitle: 'Choisir un appareil',
    discoveryDescription:
      'Simulateurs et émulateurs en cours sur cette machine.',
    emptyTitle: 'Aucun simulateur en cours',
    emptyBody:
      'Lancez un simulateur iOS ou un émulateur Android sur cette machine. Il apparaît ici dès son démarrage.',
    opening: ({ device }: { device: string }) => `Ouverture de ${device}…`,
    connectingVideo: 'Connexion à l’écran…',
    reconnecting: 'Reconnexion…',
    takeControlFirst:
      'Prenez le contrôle pour utiliser les boutons de l’appareil',
    tools: 'Outils',
    closeTools: 'Fermer les outils',
    streamSection: 'Flux',
    streamDescription: 'Allégez le flux sur une connexion lente.',
    buttonsSection: 'Boutons de l’appareil',
    switchDevice: 'Changer d’appareil',
    hideControls: 'Masquer les commandes',
    showControls: 'Afficher les commandes',
    more: 'Plus',
  },
  de: {
    discoveryTitle: 'Gerät auswählen',
    discoveryDescription:
      'Simulatoren und Emulatoren, die auf dieser Maschine laufen.',
    emptyTitle: 'Kein Simulator läuft',
    emptyBody:
      'Starte einen iOS-Simulator oder Android-Emulator auf dieser Maschine. Er erscheint hier, sobald er hochgefahren ist.',
    opening: ({ device }: { device: string }) => `${device} wird geöffnet…`,
    connectingVideo: 'Verbindung zum Bildschirm…',
    reconnecting: 'Verbindung wird wiederhergestellt…',
    takeControlFirst: 'Übernimm die Steuerung, um Gerätetasten zu drücken',
    tools: 'Werkzeuge',
    closeTools: 'Werkzeuge schließen',
    streamSection: 'Stream',
    streamDescription: 'Entlaste den Stream bei langsamer Verbindung.',
    buttonsSection: 'Gerätetasten',
    switchDevice: 'Gerät wechseln',
    hideControls: 'Steuerelemente ausblenden',
    showControls: 'Steuerelemente einblenden',
    more: 'Mehr',
  },
  es: {
    discoveryTitle: 'Elige un dispositivo',
    discoveryDescription:
      'Simuladores y emuladores que se ejecutan en esta máquina.',
    emptyTitle: 'No hay simuladores en ejecución',
    emptyBody:
      'Inicia un simulador de iOS o un emulador de Android en esta máquina. Aparecerá aquí cuando arranque.',
    opening: ({ device }: { device: string }) => `Abriendo ${device}…`,
    connectingVideo: 'Conectando con la pantalla…',
    reconnecting: 'Reconectando…',
    takeControlFirst: 'Toma el control para pulsar los botones del dispositivo',
    tools: 'Herramientas',
    closeTools: 'Cerrar herramientas',
    streamSection: 'Transmisión',
    streamDescription: 'Aligera la transmisión en una conexión lenta.',
    buttonsSection: 'Botones del dispositivo',
    switchDevice: 'Cambiar de dispositivo',
    hideControls: 'Ocultar controles',
    showControls: 'Mostrar controles',
    more: 'Más',
  },
  it: {
    discoveryTitle: 'Scegli un dispositivo',
    discoveryDescription:
      'Simulatori ed emulatori in esecuzione su questa macchina.',
    emptyTitle: 'Nessun simulatore in esecuzione',
    emptyBody:
      'Avvia un simulatore iOS o un emulatore Android su questa macchina. Comparirà qui appena avviato.',
    opening: ({ device }: { device: string }) => `Apertura di ${device}…`,
    connectingVideo: 'Connessione allo schermo…',
    reconnecting: 'Riconnessione…',
    takeControlFirst: 'Prendi il controllo per premere i tasti del dispositivo',
    tools: 'Strumenti',
    closeTools: 'Chiudi strumenti',
    streamSection: 'Stream',
    streamDescription: 'Alleggerisci lo stream su una connessione lenta.',
    buttonsSection: 'Tasti del dispositivo',
    switchDevice: 'Cambia dispositivo',
    hideControls: 'Nascondi controlli',
    showControls: 'Mostra controlli',
    more: 'Altro',
  },
  pt: {
    discoveryTitle: 'Escolha um dispositivo',
    discoveryDescription: 'Simuladores e emuladores em execução nesta máquina.',
    emptyTitle: 'Nenhum simulador em execução',
    emptyBody:
      'Inicie um simulador iOS ou um emulador Android nesta máquina. Ele aparece aqui assim que iniciar.',
    opening: ({ device }: { device: string }) => `Abrindo ${device}…`,
    connectingVideo: 'Conectando à tela…',
    reconnecting: 'Reconectando…',
    takeControlFirst: 'Assuma o controle para usar os botões do dispositivo',
    tools: 'Ferramentas',
    closeTools: 'Fechar ferramentas',
    streamSection: 'Transmissão',
    streamDescription: 'Alivie a transmissão em uma conexão lenta.',
    buttonsSection: 'Botões do dispositivo',
    switchDevice: 'Trocar de dispositivo',
    hideControls: 'Ocultar controles',
    showControls: 'Mostrar controles',
    more: 'Mais',
  },
  ca: {
    discoveryTitle: 'Tria un dispositiu',
    discoveryDescription:
      'Simuladors i emuladors que s’executen en aquesta màquina.',
    emptyTitle: 'Cap simulador en execució',
    emptyBody:
      'Inicia un simulador d’iOS o un emulador d’Android en aquesta màquina. Apareixerà aquí quan arrenqui.',
    opening: ({ device }: { device: string }) => `Obrint ${device}…`,
    connectingVideo: 'Connectant amb la pantalla…',
    reconnecting: 'Reconnectant…',
    takeControlFirst: 'Pren el control per prémer els botons del dispositiu',
    tools: 'Eines',
    closeTools: 'Tanca les eines',
    streamSection: 'Transmissió',
    streamDescription: 'Alleugereix la transmissió en una connexió lenta.',
    buttonsSection: 'Botons del dispositiu',
    switchDevice: 'Canvia de dispositiu',
    hideControls: 'Amaga els controls',
    showControls: 'Mostra els controls',
    more: 'Més',
  },
  pl: {
    discoveryTitle: 'Wybierz urządzenie',
    discoveryDescription: 'Symulatory i emulatory działające na tej maszynie.',
    emptyTitle: 'Brak uruchomionych symulatorów',
    emptyBody:
      'Uruchom symulator iOS lub emulator Androida na tej maszynie. Pojawi się tutaj po starcie.',
    opening: ({ device }: { device: string }) => `Otwieranie ${device}…`,
    connectingVideo: 'Łączenie z ekranem…',
    reconnecting: 'Ponowne łączenie…',
    takeControlFirst: 'Przejmij sterowanie, aby używać przycisków urządzenia',
    tools: 'Narzędzia',
    closeTools: 'Zamknij narzędzia',
    streamSection: 'Strumień',
    streamDescription: 'Odciąż strumień przy wolnym połączeniu.',
    buttonsSection: 'Przyciski urządzenia',
    switchDevice: 'Zmień urządzenie',
    hideControls: 'Ukryj sterowanie',
    showControls: 'Pokaż sterowanie',
    more: 'Więcej',
  },
  ru: {
    discoveryTitle: 'Выберите устройство',
    discoveryDescription: 'Симуляторы и эмуляторы, запущенные на этой машине.',
    emptyTitle: 'Нет запущенных симуляторов',
    emptyBody:
      'Запустите симулятор iOS или эмулятор Android на этой машине. Он появится здесь после загрузки.',
    opening: ({ device }: { device: string }) => `Открываем ${device}…`,
    connectingVideo: 'Подключение к экрану…',
    reconnecting: 'Переподключение…',
    takeControlFirst: 'Возьмите управление, чтобы нажимать кнопки устройства',
    tools: 'Инструменты',
    closeTools: 'Закрыть инструменты',
    streamSection: 'Поток',
    streamDescription: 'Облегчите поток при медленном соединении.',
    buttonsSection: 'Кнопки устройства',
    switchDevice: 'Сменить устройство',
    hideControls: 'Скрыть управление',
    showControls: 'Показать управление',
    more: 'Ещё',
  },
  ja: {
    discoveryTitle: 'デバイスを選択',
    discoveryDescription:
      'このマシンで実行中のシミュレーターとエミュレーター。',
    emptyTitle: '実行中のシミュレーターはありません',
    emptyBody:
      'このマシンで iOS シミュレーターまたは Android エミュレーターを起動してください。起動するとここに表示されます。',
    opening: ({ device }: { device: string }) => `${device} を開いています…`,
    connectingVideo: '画面に接続しています…',
    reconnecting: '再接続しています…',
    takeControlFirst: 'デバイスのボタンを押すには操作を引き継いでください',
    tools: 'ツール',
    closeTools: 'ツールを閉じる',
    streamSection: 'ストリーム',
    streamDescription: '低速な接続ではストリームを軽くします。',
    buttonsSection: 'デバイスのボタン',
    switchDevice: 'デバイスを切り替え',
    hideControls: 'コントロールを隠す',
    showControls: 'コントロールを表示',
    more: 'その他',
  },
  'zh-Hans': {
    discoveryTitle: '选择设备',
    discoveryDescription: '此机器上正在运行的模拟器。',
    emptyTitle: '没有正在运行的模拟器',
    emptyBody:
      '在此机器上启动 iOS 模拟器或 Android 模拟器，启动后会显示在这里。',
    opening: ({ device }: { device: string }) => `正在打开 ${device}…`,
    connectingVideo: '正在连接屏幕…',
    reconnecting: '正在重新连接…',
    takeControlFirst: '接管控制后才能按设备按键',
    tools: '工具',
    closeTools: '关闭工具',
    streamSection: '视频流',
    streamDescription: '网络较慢时减轻视频流负担。',
    buttonsSection: '设备按键',
    switchDevice: '切换设备',
    hideControls: '隐藏控件',
    showControls: '显示控件',
    more: '更多',
  },
  'zh-Hant': {
    discoveryTitle: '選擇裝置',
    discoveryDescription: '此機器上正在執行的模擬器。',
    emptyTitle: '沒有正在執行的模擬器',
    emptyBody:
      '在此機器上啟動 iOS 模擬器或 Android 模擬器，啟動後會顯示在這裡。',
    opening: ({ device }: { device: string }) => `正在開啟 ${device}…`,
    connectingVideo: '正在連線到螢幕…',
    reconnecting: '正在重新連線…',
    takeControlFirst: '接管控制後才能按裝置按鍵',
    tools: '工具',
    closeTools: '關閉工具',
    streamSection: '影像串流',
    streamDescription: '網路較慢時減輕影像串流負擔。',
    buttonsSection: '裝置按鍵',
    switchDevice: '切換裝置',
    hideControls: '隱藏控制項',
    showControls: '顯示控制項',
    more: '更多',
  },
} as const satisfies Record<SupportedLanguage, SimulatorViewerCopy>;
