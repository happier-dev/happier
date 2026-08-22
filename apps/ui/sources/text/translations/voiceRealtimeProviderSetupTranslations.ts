import { voiceProviderPrivacyTranslations } from './voiceProviderPrivacyTranslations';

/**
 * Setup, authentication, tuning fields and failure copy for the realtime voice providers.
 *
 * `en.ts` builds this subtree inline; the ten other locales get it from here. The two composed
 * branches mirror what `en.ts` does, and for the same reason: `xai.privacyDisclosure` and
 * `fields.resumption` are owned by `voiceProviderPrivacyTranslations`, and a locale file spreads
 * that module into the SAME `realtimeProviders` object. Spreading a bare `xai`/`fields` here would
 * replace those branches instead of extending them, so the privacy owner is folded in rather than
 * duplicated.
 */
type VoiceRealtimeProviderLocale = keyof typeof voiceProviderPrivacyTranslations;

type TitleSubtitle = Readonly<{ title: string; subtitle: string }>;
type PromptField = Readonly<{ title: string; subtitle: string; promptTitle: string; promptBody: string }>;

type VoiceRealtimeProviderSetupCopy = Readonly<{
  xai: Readonly<{
    setup: Readonly<{ footer: string }>;
    credential: Readonly<{ promptBody: string }>;
  }>;
  setup: Readonly<{ title: string; footer: string }>;
  credential: Readonly<{ title: string; promptTitle: string; promptBody: string }>;
  authentication: Readonly<{
    sectionTitle: string;
    title: string;
    subtitle: string;
    footer: string;
    savedSecret: TitleSubtitle;
    openAiApiKey: TitleSubtitle;
    openAiCodex: TitleSubtitle;
    account: TitleSubtitle;
    chooseAccount: string;
    referenceRequired: string;
    connected: string;
    unavailable: string;
  }>;
  invalidValue: string;
  advanced: Readonly<{ show: string; hide: string }>;
  fields: Readonly<{
    model: TitleSubtitle;
    voice: TitleSubtitle;
    instructions: PromptField;
    turnDetection: Readonly<{
      title: string;
      subtitle: string;
      threshold: PromptField;
      silenceDurationMs: PromptField;
      prefixPaddingMs: PromptField;
      idleTimeoutMs: Readonly<{
        title: string;
        subtitle: string;
        promptTitle: string;
        promptBody: string;
        confirmTitle: string;
        confirmBody: string;
        confirmAction: string;
      }>;
    }>;
    transcriptionModel: PromptField;
    reasoning: TitleSubtitle;
    outputSpeed: PromptField;
    languageHint: PromptField;
    keyterms: PromptField;
  }>;
  options: Readonly<{
    pinned: string;
    movingAlias: string;
    automatic: string;
    custom: string;
    server_vad: string;
    semantic_vad: string;
    manual: string;
    high: string;
    none: string;
  }>;
  catalog: Readonly<{
    credentialRequired: string;
    retry: string;
    empty: string;
    preview: (args: { voice: string }) => string;
  }>;
  movingAlias: Readonly<{ confirmTitle: string; confirmBody: string; confirmAction: string }>;
  links: Readonly<{ title: string; account: TitleSubtitle; apiKeys: TitleSubtitle; privacy: TitleSubtitle }>;
  disconnect: Readonly<{ title: string; subtitle: string; confirmTitle: string; confirmBody: string }>;
  unavailable: Readonly<{
    title: string;
    rowTitle: string;
    provider: string;
    invalid: string;
    needs_migration: string;
    unsupported_version: string;
  }>;
}>;

function defineVoiceRealtimeProviderSetup(
  locale: VoiceRealtimeProviderLocale,
  copy: VoiceRealtimeProviderSetupCopy,
) {
  const privacy = voiceProviderPrivacyTranslations[locale];
  return {
    ...copy,
    xai: { ...privacy.xai, ...copy.xai },
    fields: { ...copy.fields, resumption: privacy.fields.resumption },
  };
}

export const voiceRealtimeProviderSetupTranslations = {
  ru: defineVoiceRealtimeProviderSetup('ru', {
    xai: {
      setup: { footer: 'Ваш ключ API xAI хранится как синхронизированный сохранённый секрет в секретах вашего аккаунта Happier. Он используется только для ограниченной операции xAI Realtime.' },
      credential: { promptBody: 'Вставьте ключ API xAI. Happier защищает его как синхронизированный сохранённый секрет и использует только для ограниченной операции xAI Realtime.' },
    },
    setup: {
      title: 'Настройка голоса в реальном времени',
      footer: 'Ваш ключ API хранится на выбранной машине выполнения и никогда не попадает в синхронизируемые голосовые настройки.',
    },
    credential: {
      title: 'Сохранённый ключ API',
      promptTitle: 'Подключить голос в реальном времени',
      promptBody: 'Вставьте ключ API OpenAI Platform. Он защищён в синхронизируемых секретах вашего аккаунта и используется только при выпуске краткосрочных клиентских данных для Realtime.',
    },
    authentication: {
      sectionTitle: 'Аутентификация OpenAI Realtime',
      title: 'Источник аутентификации',
      subtitle: 'Выберите ровно один источник. Happier никогда не переключается на другой ключ или аккаунт.',
      footer: 'Использование OpenAI Realtime API оплачивается через OpenAI Platform. Подписка ChatGPT или Codex не даёт доступа к Realtime API и не оплачивает его. В разговор по WebRTC передаются только краткосрочные клиентские данные.',
      savedSecret: {
        title: 'Сохранённый голосовой ключ API',
        subtitle: 'Использовать ключ API, сохранённый в секретах аккаунта Happier Voice. Демон не требуется.',
      },
      openAiApiKey: {
        title: 'Подключённый сервис OpenAI',
        subtitle: 'Использовать выбранный стандартный профиль или группу аккаунтов с ключом API OpenAI через выбранную машину и её подключённый демон.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (экспериментально)',
        subtitle: 'Использовать выбранный профиль или группу аккаунтов Codex OAuth через выбранную машину и её подключённый демон. Happier никогда не переключается на другой ключ или аккаунт.',
      },
      account: {
        title: 'Подключённый аккаунт',
        subtitle: 'Выберите точный профиль или группу аккаунтов для следующего разговора.',
      },
      chooseAccount: 'Выберите аккаунт',
      referenceRequired: 'Выберите подключённый профиль или группу аккаунтов.',
      connected: 'Подключённый аккаунт готов',
      unavailable: 'Выбранный аккаунт недоступен или требует повторного подключения',
    },
    invalidValue: 'Это значение не поддерживается данным провайдером.',
    advanced: { show: 'Показать дополнительные настройки', hide: 'Скрыть дополнительные настройки' },
    fields: {
      model: { title: 'Модель', subtitle: 'Выберите модель голоса в реальном времени.' },
      voice: { title: 'Голос', subtitle: 'Выберите голос для ответов.' },
      instructions: {
        title: 'Голосовые инструкции',
        subtitle: 'Необязательные инструкции по поведению и характеру.',
        promptTitle: 'Голосовые инструкции',
        promptBody: 'Введите необязательные инструкции для этой голосовой сессии.',
      },
      turnDetection: {
        title: 'Определение конца реплики',
        subtitle: 'Выберите, как провайдер определяет конец вашей реплики.',
        threshold: {
          title: 'Порог VAD',
          subtitle: 'Чувствительность к голосовой активности; оставьте пустым для значения провайдера.',
          promptTitle: 'Порог VAD',
          promptBody: 'Введите значение от 0.1 до 0.9 или оставьте пустым.',
        },
        silenceDurationMs: {
          title: 'Длительность тишины',
          subtitle: 'Миллисекунды тишины до завершения реплики.',
          promptTitle: 'Длительность тишины',
          promptBody: 'Введите от 0 до 10000 миллисекунд или оставьте пустым.',
        },
        prefixPaddingMs: {
          title: 'Запас перед речью',
          subtitle: 'Сколько миллисекунд сохраняется до обнаруженной речи.',
          promptTitle: 'Запас перед речью',
          promptBody: 'Введите от 0 до 10000 миллисекунд или оставьте пустым.',
        },
        idleTimeoutMs: {
          title: 'Тайм-аут ответа при простое',
          subtitle: 'При желании попросить xAI начать ответ после такой паузы.',
          promptTitle: 'Тайм-аут ответа при простое',
          promptBody: 'Введите от 1 до 600000 миллисекунд или оставьте пустым, чтобы отключить автоматические ответы при простое.',
          confirmTitle: 'Включить автоматические ответы при простое?',
          confirmBody: 'После заданной паузы xAI может по своей инициативе создать ответ и израсходовать лимиты API.',
          confirmAction: 'Включить',
        },
      },
      transcriptionModel: {
        title: 'Модель транскрипции',
        subtitle: 'Необязательная модель транскрипции входного аудио.',
        promptTitle: 'Модель транскрипции',
        promptBody: 'Введите идентификатор модели или оставьте пустым для значения провайдера.',
      },
      reasoning: { title: 'Рассуждение', subtitle: 'Выберите уровень рассуждения для поддерживаемых моделей.' },
      outputSpeed: {
        title: 'Скорость речи',
        subtitle: 'Настройте скорость речи провайдера.',
        promptTitle: 'Скорость речи',
        promptBody: 'Введите значение от 0.7 до 1.5.',
      },
      languageHint: {
        title: 'Подсказка языка',
        subtitle: 'При желании помогите транскрипции определить ваш язык.',
        promptTitle: 'Подсказка языка',
        promptBody: 'Выберите поддерживаемый язык.',
      },
      keyterms: {
        title: 'Ключевые термины',
        subtitle: 'Имена и предметные термины, которые должна распознавать транскрипция.',
        promptTitle: 'Ключевые термины',
        promptBody: 'Введите до 100 терминов через запятую или с новой строки.',
      },
    },
    options: {
      pinned: 'Закреплённая версия',
      movingAlias: 'Автоматически следует обновлениям провайдера',
      automatic: 'Автоматически',
      custom: 'Свой вариант…',
      server_vad: 'Серверное определение голосовой активности',
      semantic_vad: 'Семантическое определение реплики',
      manual: 'Вручную',
      high: 'Высокий',
      none: 'Нет',
    },
    catalog: {
      credentialRequired: 'Добавьте ключ API, чтобы загрузить голоса',
      retry: 'Не удалось загрузить голоса — повторить',
      empty: 'Для этого аккаунта нет доступных голосов',
      preview: ({ voice }) => `Прослушать ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Следовать за последней моделью?',
      confirmBody: 'Подвижный псевдоним модели может изменить поведение, когда провайдер её обновит. Вы в любой момент можете вернуться к закреплённой версии.',
      confirmAction: 'Использовать последнюю',
    },
    links: {
      title: 'Ресурсы провайдера',
      account: { title: 'Открыть аккаунт провайдера', subtitle: 'Управляйте своим аккаунтом провайдера.' },
      apiKeys: { title: 'Открыть ключи API', subtitle: 'Создавайте, меняйте или отзывайте ключи API провайдера.' },
      privacy: { title: 'Политика конфиденциальности провайдера', subtitle: 'Узнайте, как провайдер обрабатывает голосовые данные.' },
    },
    disconnect: {
      title: 'Отключить голос в реальном времени',
      subtitle: 'Удалить ключ API этого провайдера с выбранной машины.',
      confirmTitle: 'Отключить провайдера?',
      confirmBody: 'Это удалит сохранённый ключ API с выбранной машины выполнения.',
    },
    unavailable: {
      title: 'Голос в реальном времени недоступен',
      rowTitle: 'Не удалось загрузить настройки',
      provider: 'Компонент провайдера недоступен или несовместим.',
      invalid: 'Сохранённые настройки провайдера некорректны.',
      needs_migration: 'Прежде чем эти настройки можно будет изменить, требуется поддерживаемая миграция.',
      unsupported_version: 'Эти настройки были записаны более новой версией Happier.',
    },
  }),
  pl: defineVoiceRealtimeProviderSetup('pl', {
    xai: {
      setup: { footer: 'Twój klucz API xAI jest przechowywany jako zsynchronizowany zapisany sekret w sekretach Twojego konta Happier. Jest używany wyłącznie do ograniczonej operacji xAI Realtime.' },
      credential: { promptBody: 'Wklej klucz API xAI. Happier chroni go jako zsynchronizowany zapisany sekret i używa wyłącznie do ograniczonej operacji xAI Realtime.' },
    },
    setup: {
      title: 'Konfiguracja głosu w czasie rzeczywistym',
      footer: 'Twój klucz API jest przechowywany na wybranej maszynie wykonawczej i nigdy nie trafia do synchronizowanych ustawień głosu.',
    },
    credential: {
      title: 'Zapisany klucz API',
      promptTitle: 'Połącz głos w czasie rzeczywistym',
      promptBody: 'Wklej klucz API OpenAI Platform. Jest chroniony w zsynchronizowanych sekretach Twojego konta i używany tylko podczas tworzenia krótkotrwałych danych uwierzytelniających klienta Realtime.',
    },
    authentication: {
      sectionTitle: 'Uwierzytelnianie OpenAI Realtime',
      title: 'Źródło uwierzytelniania',
      subtitle: 'Wybierz dokładnie jedno źródło. Happier nigdy nie przełącza się na inny klucz ani konto.',
      footer: 'Korzystanie z OpenAI Realtime API jest rozliczane przez OpenAI Platform. Subskrypcja ChatGPT ani Codex nie oznacza rozliczenia ani dostępu do Realtime API. Do rozmowy WebRTC przekazywane są wyłącznie krótkotrwałe dane uwierzytelniające klienta.',
      savedSecret: {
        title: 'Zapisany głosowy klucz API',
        subtitle: 'Użyj klucza API zapisanego w sekretach konta Happier Voice. Demon nie jest wymagany.',
      },
      openAiApiKey: {
        title: 'Połączona usługa OpenAI',
        subtitle: 'Użyj wybranego standardowego profilu lub grupy kont z kluczem API OpenAI za pośrednictwem wybranej maszyny i jej połączonego demona.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (eksperymentalne)',
        subtitle: 'Użyj wybranego profilu lub grupy kont Codex OAuth za pośrednictwem wybranej maszyny i jej połączonego demona. Happier nigdy nie przełącza się na inny klucz ani konto.',
      },
      account: {
        title: 'Połączone konto',
        subtitle: 'Wybierz dokładny profil lub grupę kont używaną w następnej rozmowie.',
      },
      chooseAccount: 'Wybierz konto',
      referenceRequired: 'Wybierz połączony profil lub grupę kont.',
      connected: 'Połączone konto gotowe',
      unavailable: 'Wybrane konto niedostępne lub wymaga ponownego połączenia',
    },
    invalidValue: 'Ta wartość nie jest obsługiwana przez tego dostawcę.',
    advanced: { show: 'Pokaż ustawienia zaawansowane', hide: 'Ukryj ustawienia zaawansowane' },
    fields: {
      model: { title: 'Model głosu', subtitle: 'Wybierz model głosu czasu rzeczywistego.' },
      voice: { title: 'Głos', subtitle: 'Wybierz głos używany w odpowiedziach.' },
      instructions: {
        title: 'Instrukcje głosowe',
        subtitle: 'Opcjonalne instrukcje dotyczące zachowania i osobowości.',
        promptTitle: 'Instrukcje głosowe',
        promptBody: 'Wprowadź opcjonalne instrukcje dla tej sesji głosowej.',
      },
      turnDetection: {
        title: 'Wykrywanie końca wypowiedzi',
        subtitle: 'Wybierz, jak dostawca wykrywa koniec Twojej wypowiedzi.',
        threshold: {
          title: 'Próg VAD',
          subtitle: 'Czułość wykrywania mowy; pozostaw puste, aby użyć wartości dostawcy.',
          promptTitle: 'Próg VAD',
          promptBody: 'Wprowadź wartość od 0.1 do 0.9 albo pozostaw puste.',
        },
        silenceDurationMs: {
          title: 'Czas ciszy',
          subtitle: 'Milisekundy ciszy przed zakończeniem wypowiedzi.',
          promptTitle: 'Czas ciszy',
          promptBody: 'Wprowadź od 0 do 10000 milisekund albo pozostaw puste.',
        },
        prefixPaddingMs: {
          title: 'Zapas przed mową',
          subtitle: 'Liczba milisekund zachowywanych przed wykrytą mową.',
          promptTitle: 'Zapas przed mową',
          promptBody: 'Wprowadź od 0 do 10000 milisekund albo pozostaw puste.',
        },
        idleTimeoutMs: {
          title: 'Limit czasu odpowiedzi przy bezczynności',
          subtitle: 'Opcjonalnie poproś xAI o rozpoczęcie odpowiedzi po takiej ciszy.',
          promptTitle: 'Limit czasu odpowiedzi przy bezczynności',
          promptBody: 'Wprowadź od 1 do 600000 milisekund albo pozostaw puste, aby wyłączyć automatyczne odpowiedzi przy bezczynności.',
          confirmTitle: 'Włączyć automatyczne odpowiedzi przy bezczynności?',
          confirmBody: 'Po skonfigurowanej ciszy xAI może samodzielnie utworzyć odpowiedź i zużyć limit API.',
          confirmAction: 'Włącz',
        },
      },
      transcriptionModel: {
        title: 'Model transkrypcji',
        subtitle: 'Opcjonalny model transkrypcji wejścia.',
        promptTitle: 'Model transkrypcji',
        promptBody: 'Wprowadź identyfikator modelu albo pozostaw puste, aby użyć wartości dostawcy.',
      },
      reasoning: { title: 'Rozumowanie', subtitle: 'Wybierz poziom rozumowania dla obsługiwanych modeli.' },
      outputSpeed: {
        title: 'Tempo mówienia',
        subtitle: 'Dostosuj tempo mówienia dostawcy.',
        promptTitle: 'Tempo mówienia',
        promptBody: 'Wprowadź wartość od 0.7 do 1.5.',
      },
      languageHint: {
        title: 'Podpowiedź języka',
        subtitle: 'Opcjonalnie pomóż transkrypcji rozpoznać Twój język.',
        promptTitle: 'Podpowiedź języka',
        promptBody: 'Wybierz obsługiwany język.',
      },
      keyterms: {
        title: 'Kluczowe terminy',
        subtitle: 'Nazwy i terminy dziedzinowe, które transkrypcja powinna rozpoznawać.',
        promptTitle: 'Kluczowe terminy',
        promptBody: 'Wprowadź maksymalnie 100 terminów oddzielonych przecinkami lub nowymi wierszami.',
      },
    },
    options: {
      pinned: 'Przypięta wersja',
      movingAlias: 'Automatycznie podąża za aktualizacjami dostawcy',
      automatic: 'Automatycznie',
      custom: 'Własne…',
      server_vad: 'Serwerowe wykrywanie aktywności głosowej',
      semantic_vad: 'Semantyczne wykrywanie wypowiedzi',
      manual: 'Ręcznie',
      high: 'Wysoki',
      none: 'Brak',
    },
    catalog: {
      credentialRequired: 'Dodaj klucz API, aby wczytać głosy',
      retry: 'Nie udało się wczytać głosów — ponów',
      empty: 'Dla tego konta nie ma dostępnych głosów',
      preview: ({ voice }) => `Odsłuchaj ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Podążać za najnowszym modelem?',
      confirmBody: 'Ruchomy alias modelu może zmienić zachowanie, gdy dostawca go zaktualizuje. W każdej chwili możesz wrócić do przypiętej wersji.',
      confirmAction: 'Użyj najnowszego',
    },
    links: {
      title: 'Zasoby dostawcy',
      account: { title: 'Otwórz konto dostawcy', subtitle: 'Zarządzaj swoim kontem u dostawcy.' },
      apiKeys: { title: 'Otwórz klucze API', subtitle: 'Twórz, rotuj lub unieważniaj klucze API dostawcy.' },
      privacy: { title: 'Polityka prywatności dostawcy', subtitle: 'Sprawdź, jak dostawca przetwarza dane głosowe.' },
    },
    disconnect: {
      title: 'Odłącz głos w czasie rzeczywistym',
      subtitle: 'Usuń klucz API tego dostawcy z wybranej maszyny.',
      confirmTitle: 'Odłączyć dostawcę?',
      confirmBody: 'Spowoduje to usunięcie zapisanego klucza API z wybranej maszyny wykonawczej.',
    },
    unavailable: {
      title: 'Głos w czasie rzeczywistym niedostępny',
      rowTitle: 'Nie udało się wczytać ustawień',
      provider: 'Wtyczka dostawcy jest niedostępna lub niezgodna.',
      invalid: 'Zapisane ustawienia dostawcy są nieprawidłowe.',
      needs_migration: 'Te ustawienia wymagają obsługiwanej migracji, zanim będzie można je edytować.',
      unsupported_version: 'Te ustawienia zostały zapisane przez nowszą wersję Happier.',
    },
  }),
  es: defineVoiceRealtimeProviderSetup('es', {
    xai: {
      setup: { footer: 'Tu clave de API de xAI se guarda como un secreto sincronizado en los secretos de tu cuenta de Happier. Solo se materializa para la operación acotada de xAI Realtime.' },
      credential: { promptBody: 'Pega una clave de API de xAI. Happier la protege como un secreto guardado sincronizado y solo la materializa para la operación acotada de xAI Realtime.' },
    },
    setup: {
      title: 'Configuración de voz en tiempo real',
      footer: 'Tu clave de API se guarda en la máquina de ejecución seleccionada y nunca se incluye en los ajustes de voz sincronizados.',
    },
    credential: {
      title: 'Clave de API guardada',
      promptTitle: 'Conectar la voz en tiempo real',
      promptBody: 'Pega una clave de API de OpenAI Platform. Se protege en los secretos sincronizados de tu cuenta y solo se materializa al emitir credenciales de cliente de Realtime de corta duración.',
    },
    authentication: {
      sectionTitle: 'Autenticación de OpenAI Realtime',
      title: 'Fuente de autenticación',
      subtitle: 'Elige exactamente una fuente. Happier nunca recurre a otra clave ni a otra cuenta.',
      footer: 'El uso de la API de OpenAI Realtime lo factura OpenAI Platform. Una suscripción a ChatGPT o Codex no implica facturación ni acceso a la API de Realtime. A la conversación por WebRTC solo se le pasan credenciales de cliente de corta duración.',
      savedSecret: {
        title: 'Clave de API de voz guardada',
        subtitle: 'Usa la clave de API guardada en los secretos de la cuenta de Happier Voice. No hace falta ningún demonio.',
      },
      openAiApiKey: {
        title: 'Servicio conectado de OpenAI',
        subtitle: 'Usa el perfil o grupo de cuentas estándar de clave de API de OpenAI seleccionado a través de la máquina elegida y su demonio conectado.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (experimental)',
        subtitle: 'Usa el perfil o grupo de cuentas de Codex OAuth seleccionado a través de la máquina elegida y su demonio conectado. Happier nunca recurre a otra clave ni a otra cuenta.',
      },
      account: {
        title: 'Cuenta conectada',
        subtitle: 'Elige el perfil o grupo de cuentas exacto que se usará en la próxima conversación.',
      },
      chooseAccount: 'Elige una cuenta',
      referenceRequired: 'Elige un perfil o grupo de cuentas conectado.',
      connected: 'Cuenta conectada lista',
      unavailable: 'La cuenta seleccionada no está disponible o necesita reconectarse',
    },
    invalidValue: 'Este proveedor no admite ese valor.',
    advanced: { show: 'Mostrar ajustes avanzados', hide: 'Ocultar ajustes avanzados' },
    fields: {
      model: { title: 'Modelo', subtitle: 'Elige el modelo de voz en tiempo real.' },
      voice: { title: 'Voz', subtitle: 'Elige la voz que se usa en las respuestas.' },
      instructions: {
        title: 'Instrucciones de voz',
        subtitle: 'Instrucciones opcionales de comportamiento y personalidad.',
        promptTitle: 'Instrucciones de voz',
        promptBody: 'Escribe instrucciones opcionales para esta sesión de voz.',
      },
      turnDetection: {
        title: 'Detección de turno',
        subtitle: 'Elige cómo detecta el proveedor el final de tu turno.',
        threshold: {
          title: 'Umbral de VAD',
          subtitle: 'Sensibilidad a la actividad de voz; déjalo en blanco para el valor del proveedor.',
          promptTitle: 'Umbral de VAD',
          promptBody: 'Introduce un valor de 0.1 a 0.9, o déjalo en blanco.',
        },
        silenceDurationMs: {
          title: 'Duración del silencio',
          subtitle: 'Milisegundos de silencio antes de terminar un turno.',
          promptTitle: 'Duración del silencio',
          promptBody: 'Introduce de 0 a 10000 milisegundos, o déjalo en blanco.',
        },
        prefixPaddingMs: {
          title: 'Margen previo al habla',
          subtitle: 'Milisegundos que se conservan antes del habla detectada.',
          promptTitle: 'Margen previo al habla',
          promptBody: 'Introduce de 0 a 10000 milisegundos, o déjalo en blanco.',
        },
        idleTimeoutMs: {
          title: 'Tiempo de espera de respuesta por inactividad',
          subtitle: 'Opcionalmente, pide a xAI que empiece una respuesta tras ese silencio.',
          promptTitle: 'Tiempo de espera de respuesta por inactividad',
          promptBody: 'Introduce de 1 a 600000 milisegundos, o déjalo en blanco para desactivar las respuestas automáticas por inactividad.',
          confirmTitle: '¿Activar las respuestas automáticas por inactividad?',
          confirmBody: 'Tras el silencio configurado, xAI puede crear una respuesta por su cuenta y consumir uso de la API.',
          confirmAction: 'Activar',
        },
      },
      transcriptionModel: {
        title: 'Modelo de transcripción',
        subtitle: 'Modelo opcional de transcripción de la entrada.',
        promptTitle: 'Modelo de transcripción',
        promptBody: 'Introduce un id de modelo, o déjalo en blanco para el valor del proveedor.',
      },
      reasoning: { title: 'Razonamiento', subtitle: 'Elige el esfuerzo de razonamiento para los modelos compatibles.' },
      outputSpeed: {
        title: 'Velocidad al hablar',
        subtitle: 'Ajusta la velocidad de habla del proveedor.',
        promptTitle: 'Velocidad al hablar',
        promptBody: 'Introduce un valor de 0.7 a 1.5.',
      },
      languageHint: {
        title: 'Pista de idioma',
        subtitle: 'Opcionalmente, ayuda a la transcripción a identificar tu idioma.',
        promptTitle: 'Pista de idioma',
        promptBody: 'Elige un idioma compatible.',
      },
      keyterms: {
        title: 'Términos clave',
        subtitle: 'Nombres y términos del dominio que la transcripción debería reconocer.',
        promptTitle: 'Términos clave',
        promptBody: 'Introduce hasta 100 términos separados por comas o saltos de línea.',
      },
    },
    options: {
      pinned: 'Versión fijada',
      movingAlias: 'Sigue automáticamente las actualizaciones del proveedor',
      automatic: 'Automático',
      custom: 'Personalizado…',
      server_vad: 'Detección de actividad de voz en el servidor',
      semantic_vad: 'Detección semántica de turno',
      manual: 'Manual',
      high: 'Alto',
      none: 'Ninguno',
    },
    catalog: {
      credentialRequired: 'Añade una clave de API para cargar las voces',
      retry: 'No se pudieron cargar las voces: reintentar',
      empty: 'No hay voces disponibles para esta cuenta',
      preview: ({ voice }) => `Escuchar ${voice}`,
    },
    movingAlias: {
      confirmTitle: '¿Seguir el modelo más reciente?',
      confirmBody: 'Un alias de modelo móvil puede cambiar el comportamiento cuando el proveedor lo actualice. Puedes volver a una versión fijada cuando quieras.',
      confirmAction: 'Usar el más reciente',
    },
    links: {
      title: 'Recursos del proveedor',
      account: { title: 'Abrir la cuenta del proveedor', subtitle: 'Gestiona tu cuenta del proveedor.' },
      apiKeys: { title: 'Abrir las claves de API', subtitle: 'Crea, rota o revoca claves de API del proveedor.' },
      privacy: { title: 'Política de privacidad del proveedor', subtitle: 'Consulta cómo trata el proveedor los datos de voz.' },
    },
    disconnect: {
      title: 'Desconectar la voz en tiempo real',
      subtitle: 'Quita la clave de API de este proveedor de la máquina seleccionada.',
      confirmTitle: '¿Desconectar el proveedor?',
      confirmBody: 'Esto quita la clave de API guardada de la máquina de ejecución seleccionada.',
    },
    unavailable: {
      title: 'Voz en tiempo real no disponible',
      rowTitle: 'No se pudieron cargar los ajustes',
      provider: 'La contribución del proveedor no está disponible o no es compatible.',
      invalid: 'Los ajustes guardados del proveedor no son válidos.',
      needs_migration: 'Estos ajustes necesitan una migración compatible antes de poder editarse.',
      unsupported_version: 'Estos ajustes los escribió una versión más reciente de Happier.',
    },
  }),
  fr: defineVoiceRealtimeProviderSetup('fr', {
    xai: {
      setup: { footer: 'Ta clé API xAI est stockée comme secret enregistré synchronisé dans les secrets de ton compte Happier. Elle n’est matérialisée que pour l’opération xAI Realtime délimitée.' },
      credential: { promptBody: 'Colle une clé API xAI. Happier la protège comme un secret enregistré synchronisé et ne la matérialise que pour l’opération xAI Realtime délimitée.' },
    },
    setup: {
      title: 'Configuration de la voix en temps réel',
      footer: 'Ta clé API est stockée sur la machine d’exécution sélectionnée et n’est jamais incluse dans les réglages vocaux synchronisés.',
    },
    credential: {
      title: 'Clé API enregistrée',
      promptTitle: 'Connecter la voix en temps réel',
      promptBody: 'Colle une clé API OpenAI Platform. Elle est protégée dans les secrets synchronisés de ton compte et n’est matérialisée que pour émettre une authentification client Realtime de courte durée.',
    },
    authentication: {
      sectionTitle: 'Authentification OpenAI Realtime',
      title: 'Source d’authentification',
      subtitle: 'Choisis exactement une source. Happier ne bascule jamais vers une autre clé ou un autre compte.',
      footer: 'L’utilisation de l’API OpenAI Realtime est facturée par OpenAI Platform. Un abonnement ChatGPT ou Codex n’implique ni facturation ni accès à l’API Realtime. Seule une authentification client de courte durée est transmise à la conversation WebRTC.',
      savedSecret: {
        title: 'Clé API Voice enregistrée',
        subtitle: 'Utiliser la clé API stockée dans les secrets du compte Happier Voice. Aucun démon n’est nécessaire.',
      },
      openAiApiKey: {
        title: 'Service connecté OpenAI',
        subtitle: 'Utiliser le profil ou le groupe de comptes clé API OpenAI standard sélectionné via la machine choisie et son démon connecté.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (expérimental)',
        subtitle: 'Utiliser le profil ou le groupe de comptes Codex OAuth sélectionné via la machine choisie et son démon connecté. Happier ne bascule jamais vers une autre clé ou un autre compte.',
      },
      account: {
        title: 'Compte connecté',
        subtitle: 'Choisis le profil ou le groupe de comptes exact utilisé pour la prochaine conversation.',
      },
      chooseAccount: 'Choisis un compte',
      referenceRequired: 'Choisis un profil ou un groupe de comptes connecté.',
      connected: 'Compte connecté prêt',
      unavailable: 'Compte sélectionné indisponible ou à reconnecter',
    },
    invalidValue: 'Cette valeur n’est pas prise en charge par ce provider.',
    advanced: { show: 'Afficher les réglages avancés', hide: 'Masquer les réglages avancés' },
    fields: {
      model: { title: 'Modèle', subtitle: 'Choisis le modèle de voix en temps réel.' },
      voice: { title: 'Voix', subtitle: 'Choisis la voix utilisée pour les réponses.' },
      instructions: {
        title: 'Instructions vocales',
        subtitle: 'Instructions facultatives de comportement et de personnalité.',
        promptTitle: 'Instructions vocales',
        promptBody: 'Saisis des instructions facultatives pour cette session vocale.',
      },
      turnDetection: {
        title: 'Détection de fin de tour',
        subtitle: 'Choisis comment le provider détecte la fin de ton tour de parole.',
        threshold: {
          title: 'Seuil VAD',
          subtitle: 'Sensibilité à l’activité vocale ; laisse vide pour la valeur du provider.',
          promptTitle: 'Seuil VAD',
          promptBody: 'Saisis une valeur de 0.1 à 0.9, ou laisse vide.',
        },
        silenceDurationMs: {
          title: 'Durée de silence',
          subtitle: 'Millisecondes de silence avant de terminer un tour.',
          promptTitle: 'Durée de silence',
          promptBody: 'Saisis de 0 à 10000 millisecondes, ou laisse vide.',
        },
        prefixPaddingMs: {
          title: 'Marge avant la parole',
          subtitle: 'Millisecondes conservées avant la parole détectée.',
          promptTitle: 'Marge avant la parole',
          promptBody: 'Saisis de 0 à 10000 millisecondes, ou laisse vide.',
        },
        idleTimeoutMs: {
          title: 'Délai de réponse en cas d’inactivité',
          subtitle: 'Demander éventuellement à xAI de lancer une réponse après ce silence.',
          promptTitle: 'Délai de réponse en cas d’inactivité',
          promptBody: 'Saisis de 1 à 600000 millisecondes, ou laisse vide pour désactiver les réponses automatiques en cas d’inactivité.',
          confirmTitle: 'Activer les réponses automatiques en cas d’inactivité ?',
          confirmBody: 'Après le silence configuré, xAI peut créer une réponse de sa propre initiative et consommer de l’usage API.',
          confirmAction: 'Activer',
        },
      },
      transcriptionModel: {
        title: 'Modèle de transcription',
        subtitle: 'Modèle facultatif de transcription de l’entrée.',
        promptTitle: 'Modèle de transcription',
        promptBody: 'Saisis un identifiant de modèle, ou laisse vide pour la valeur du provider.',
      },
      reasoning: { title: 'Raisonnement', subtitle: 'Choisis l’effort de raisonnement pour les modèles compatibles.' },
      outputSpeed: {
        title: 'Vitesse de parole',
        subtitle: 'Ajuste la vitesse de parole du provider.',
        promptTitle: 'Vitesse de parole',
        promptBody: 'Saisis une valeur de 0.7 à 1.5.',
      },
      languageHint: {
        title: 'Indice de langue',
        subtitle: 'Aide éventuellement la transcription à identifier ta langue.',
        promptTitle: 'Indice de langue',
        promptBody: 'Choisis une langue prise en charge.',
      },
      keyterms: {
        title: 'Termes clés',
        subtitle: 'Noms et termes métier que la transcription doit reconnaître.',
        promptTitle: 'Termes clés',
        promptBody: 'Saisis jusqu’à 100 termes séparés par des virgules ou des retours à la ligne.',
      },
    },
    options: {
      pinned: 'Version épinglée',
      movingAlias: 'Suit automatiquement les mises à jour du provider',
      automatic: 'Automatique',
      custom: 'Personnalisé…',
      server_vad: 'Détection d’activité vocale côté serveur',
      semantic_vad: 'Détection sémantique de fin de tour',
      manual: 'Manuel',
      high: 'Élevé',
      none: 'Aucun',
    },
    catalog: {
      credentialRequired: 'Ajoute une clé API pour charger les voix',
      retry: 'Impossible de charger les voix — réessayer',
      empty: 'Aucune voix n’est disponible pour ce compte',
      preview: ({ voice }) => `Écouter ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Suivre le dernier modèle ?',
      confirmBody: 'Un alias de modèle mouvant peut changer de comportement lorsque le provider le met à jour. Tu peux revenir à une version épinglée à tout moment.',
      confirmAction: 'Utiliser le dernier',
    },
    links: {
      title: 'Ressources du provider',
      account: { title: 'Ouvrir le compte du provider', subtitle: 'Gère ton compte chez le provider.' },
      apiKeys: { title: 'Ouvrir les clés API', subtitle: 'Crée, renouvelle ou révoque les clés API du provider.' },
      privacy: { title: 'Politique de confidentialité du provider', subtitle: 'Consulte la façon dont le provider traite les données vocales.' },
    },
    disconnect: {
      title: 'Déconnecter la voix en temps réel',
      subtitle: 'Supprimer la clé API de ce provider de la machine sélectionnée.',
      confirmTitle: 'Déconnecter le provider ?',
      confirmBody: 'Cette action supprime la clé API stockée de la machine d’exécution sélectionnée.',
    },
    unavailable: {
      title: 'Voix en temps réel indisponible',
      rowTitle: 'Impossible de charger les réglages',
      provider: 'La contribution du provider est indisponible ou incompatible.',
      invalid: 'Les réglages enregistrés du provider sont invalides.',
      needs_migration: 'Ces réglages nécessitent une migration prise en charge avant de pouvoir être modifiés.',
      unsupported_version: 'Ces réglages ont été écrits par une version plus récente de Happier.',
    },
  }),
  it: defineVoiceRealtimeProviderSetup('it', {
    xai: {
      setup: { footer: 'La tua chiave API xAI è archiviata come segreto salvato sincronizzato nei segreti del tuo account Happier. Viene materializzata solo per l’operazione xAI Realtime delimitata.' },
      credential: { promptBody: 'Incolla una chiave API xAI. Happier la protegge come segreto salvato sincronizzato e la materializza solo per l’operazione xAI Realtime delimitata.' },
    },
    setup: {
      title: 'Configurazione della voce in tempo reale',
      footer: 'La tua chiave API è archiviata sulla macchina di esecuzione selezionata e non viene mai inclusa nelle impostazioni vocali sincronizzate.',
    },
    credential: {
      title: 'Chiave API salvata',
      promptTitle: 'Collega la voce in tempo reale',
      promptBody: 'Incolla una chiave API di OpenAI Platform. È protetta nei segreti sincronizzati del tuo account e viene materializzata solo per emettere credenziali client Realtime di breve durata.',
    },
    authentication: {
      sectionTitle: 'Autenticazione OpenAI Realtime',
      title: 'Origine dell’autenticazione',
      subtitle: 'Scegli esattamente un’origine. Happier non ripiega mai su un’altra chiave o un altro account.',
      footer: 'L’uso dell’API OpenAI Realtime è fatturato da OpenAI Platform. Un abbonamento ChatGPT o Codex non implica la fatturazione né l’accesso all’API Realtime. Alla conversazione WebRTC vengono passate solo credenziali client di breve durata.',
      savedSecret: {
        title: 'Chiave API vocale salvata',
        subtitle: 'Usa la chiave API archiviata nei segreti dell’account Happier Voice. Non serve alcun demone.',
      },
      openAiApiKey: {
        title: 'Servizio connesso OpenAI',
        subtitle: 'Usa il profilo o il gruppo di account con chiave API OpenAI standard selezionato tramite la macchina scelta e il suo demone connesso.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (sperimentale)',
        subtitle: 'Usa il profilo o il gruppo di account Codex OAuth selezionato tramite la macchina scelta e il suo demone connesso. Happier non ripiega mai su un’altra chiave o un altro account.',
      },
      account: {
        title: 'Account connesso',
        subtitle: 'Scegli il profilo o il gruppo di account esatto usato per la prossima conversazione.',
      },
      chooseAccount: 'Scegli un account',
      referenceRequired: 'Scegli un profilo o un gruppo di account connesso.',
      connected: 'Account connesso pronto',
      unavailable: 'Account selezionato non disponibile o da riconnettere',
    },
    invalidValue: 'Questo provider non supporta quel valore.',
    advanced: { show: 'Mostra impostazioni avanzate', hide: 'Nascondi impostazioni avanzate' },
    fields: {
      model: { title: 'Modello', subtitle: 'Scegli il modello vocale in tempo reale.' },
      voice: { title: 'Voce', subtitle: 'Scegli la voce usata per le risposte.' },
      instructions: {
        title: 'Istruzioni vocali',
        subtitle: 'Istruzioni facoltative su comportamento e personalità.',
        promptTitle: 'Istruzioni vocali',
        promptBody: 'Inserisci istruzioni facoltative per questa sessione vocale.',
      },
      turnDetection: {
        title: 'Rilevamento del turno',
        subtitle: 'Scegli come il provider rileva la fine del tuo turno.',
        threshold: {
          title: 'Soglia VAD',
          subtitle: 'Sensibilità all’attività vocale; lascia vuoto per il valore del provider.',
          promptTitle: 'Soglia VAD',
          promptBody: 'Inserisci un valore da 0.1 a 0.9 oppure lascia vuoto.',
        },
        silenceDurationMs: {
          title: 'Durata del silenzio',
          subtitle: 'Millisecondi di silenzio prima di terminare un turno.',
          promptTitle: 'Durata del silenzio',
          promptBody: 'Inserisci da 0 a 10000 millisecondi oppure lascia vuoto.',
        },
        prefixPaddingMs: {
          title: 'Margine prima del parlato',
          subtitle: 'Millisecondi conservati prima del parlato rilevato.',
          promptTitle: 'Margine prima del parlato',
          promptBody: 'Inserisci da 0 a 10000 millisecondi oppure lascia vuoto.',
        },
        idleTimeoutMs: {
          title: 'Timeout di risposta in inattività',
          subtitle: 'Puoi chiedere a xAI di avviare una risposta dopo questo silenzio.',
          promptTitle: 'Timeout di risposta in inattività',
          promptBody: 'Inserisci da 1 a 600000 millisecondi oppure lascia vuoto per disattivare le risposte automatiche in inattività.',
          confirmTitle: 'Attivare le risposte automatiche in inattività?',
          confirmBody: 'Dopo il silenzio configurato, xAI può creare una risposta di propria iniziativa e consumare utilizzo API.',
          confirmAction: 'Attiva',
        },
      },
      transcriptionModel: {
        title: 'Modello di trascrizione',
        subtitle: 'Modello facoltativo per la trascrizione dell’input.',
        promptTitle: 'Modello di trascrizione',
        promptBody: 'Inserisci un id di modello oppure lascia vuoto per il valore del provider.',
      },
      reasoning: { title: 'Ragionamento', subtitle: 'Scegli il livello di ragionamento per i modelli supportati.' },
      outputSpeed: {
        title: 'Velocità di lettura',
        subtitle: 'Regola la velocità con cui parla il provider.',
        promptTitle: 'Velocità di lettura',
        promptBody: 'Inserisci un valore da 0.7 a 1.5.',
      },
      languageHint: {
        title: 'Suggerimento di lingua',
        subtitle: 'Puoi aiutare la trascrizione a identificare la tua lingua.',
        promptTitle: 'Suggerimento di lingua',
        promptBody: 'Scegli una lingua supportata.',
      },
      keyterms: {
        title: 'Termini chiave',
        subtitle: 'Nomi e termini di dominio che la trascrizione dovrebbe riconoscere.',
        promptTitle: 'Termini chiave',
        promptBody: 'Inserisci fino a 100 termini separati da virgole o da a capo.',
      },
    },
    options: {
      pinned: 'Versione bloccata',
      movingAlias: 'Segue automaticamente gli aggiornamenti del provider',
      automatic: 'Automatico',
      custom: 'Personalizzato…',
      server_vad: 'Rilevamento dell’attività vocale sul server',
      semantic_vad: 'Rilevamento semantico del turno',
      manual: 'Manuale',
      high: 'Alto',
      none: 'Nessuno',
    },
    catalog: {
      credentialRequired: 'Aggiungi una chiave API per caricare le voci',
      retry: 'Impossibile caricare le voci — riprova',
      empty: 'Per questo account non è disponibile alcuna voce',
      preview: ({ voice }) => `Ascolta ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Seguire il modello più recente?',
      confirmBody: 'Un alias di modello mobile può cambiare comportamento quando il provider lo aggiorna. Puoi tornare a una versione bloccata in qualsiasi momento.',
      confirmAction: 'Usa il più recente',
    },
    links: {
      title: 'Risorse del provider',
      account: { title: 'Apri l’account del provider', subtitle: 'Gestisci il tuo account presso il provider.' },
      apiKeys: { title: 'Apri le chiavi API', subtitle: 'Crea, ruota o revoca le chiavi API del provider.' },
      privacy: { title: 'Informativa sulla privacy del provider', subtitle: 'Consulta come il provider tratta i dati vocali.' },
    },
    disconnect: {
      title: 'Disconnetti la voce in tempo reale',
      subtitle: 'Rimuovi la chiave API di questo provider dalla macchina selezionata.',
      confirmTitle: 'Disconnettere il provider?',
      confirmBody: 'Questa azione rimuove la chiave API archiviata dalla macchina di esecuzione selezionata.',
    },
    unavailable: {
      title: 'Voce in tempo reale non disponibile',
      rowTitle: 'Impossibile caricare le impostazioni',
      provider: 'Il contributo del provider non è disponibile o non è compatibile.',
      invalid: 'Le impostazioni salvate del provider non sono valide.',
      needs_migration: 'Queste impostazioni richiedono una migrazione supportata prima di poter essere modificate.',
      unsupported_version: 'Queste impostazioni sono state scritte da una versione più recente di Happier.',
    },
  }),
  pt: defineVoiceRealtimeProviderSetup('pt', {
    xai: {
      setup: { footer: 'A sua chave de API da xAI é guardada como segredo sincronizado nos segredos da sua conta Happier. Só é materializada para a operação delimitada da xAI Realtime.' },
      credential: { promptBody: 'Cole uma chave de API da xAI. O Happier protege-a como segredo guardado sincronizado e só a materializa para a operação delimitada da xAI Realtime.' },
    },
    setup: {
      title: 'Configuração da voz em tempo real',
      footer: 'A sua chave de API é guardada na máquina de execução selecionada e nunca é incluída nas definições de voz sincronizadas.',
    },
    credential: {
      title: 'Chave de API guardada',
      promptTitle: 'Ligar a voz em tempo real',
      promptBody: 'Cole uma chave de API da OpenAI Platform. É protegida nos segredos sincronizados da sua conta e só é materializada ao emitir credenciais de cliente Realtime de curta duração.',
    },
    authentication: {
      sectionTitle: 'Autenticação da OpenAI Realtime',
      title: 'Origem da autenticação',
      subtitle: 'Escolha exatamente uma origem. O Happier nunca recorre a outra chave nem a outra conta.',
      footer: 'A utilização da API OpenAI Realtime é faturada pela OpenAI Platform. Uma subscrição do ChatGPT ou do Codex não implica faturação nem acesso à API Realtime. Para a conversa por WebRTC só são passadas credenciais de cliente de curta duração.',
      savedSecret: {
        title: 'Chave de API de voz guardada',
        subtitle: 'Use a chave de API guardada nos segredos da conta Happier Voice. Não é necessário nenhum daemon.',
      },
      openAiApiKey: {
        title: 'Serviço ligado da OpenAI',
        subtitle: 'Use o perfil ou grupo de contas com chave de API padrão da OpenAI selecionado através da máquina escolhida e do respetivo daemon ligado.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (experimental)',
        subtitle: 'Use o perfil ou grupo de contas Codex OAuth selecionado através da máquina escolhida e do respetivo daemon ligado. O Happier nunca recorre a outra chave nem a outra conta.',
      },
      account: {
        title: 'Conta ligada',
        subtitle: 'Escolha o perfil ou grupo de contas exato usado na próxima conversa.',
      },
      chooseAccount: 'Escolha uma conta',
      referenceRequired: 'Escolha um perfil ou grupo de contas ligado.',
      connected: 'Conta ligada pronta',
      unavailable: 'Conta selecionada indisponível ou a precisar de nova ligação',
    },
    invalidValue: 'Este fornecedor não suporta esse valor.',
    advanced: { show: 'Mostrar definições avançadas', hide: 'Ocultar definições avançadas' },
    fields: {
      model: { title: 'Modelo', subtitle: 'Escolha o modelo de voz em tempo real.' },
      voice: { title: 'Voz', subtitle: 'Escolha a voz usada nas respostas.' },
      instructions: {
        title: 'Instruções de voz',
        subtitle: 'Instruções opcionais de comportamento e personalidade.',
        promptTitle: 'Instruções de voz',
        promptBody: 'Escreva instruções opcionais para esta sessão de voz.',
      },
      turnDetection: {
        title: 'Deteção do fim da fala',
        subtitle: 'Escolha como o fornecedor deteta o fim da sua vez de falar.',
        threshold: {
          title: 'Limiar de VAD',
          subtitle: 'Sensibilidade à atividade de voz; deixe em branco para o valor do fornecedor.',
          promptTitle: 'Limiar de VAD',
          promptBody: 'Introduza um valor de 0.1 a 0.9 ou deixe em branco.',
        },
        silenceDurationMs: {
          title: 'Duração do silêncio',
          subtitle: 'Milissegundos de silêncio antes de terminar a vez de falar.',
          promptTitle: 'Duração do silêncio',
          promptBody: 'Introduza de 0 a 10000 milissegundos ou deixe em branco.',
        },
        prefixPaddingMs: {
          title: 'Margem antes da fala',
          subtitle: 'Milissegundos conservados antes da fala detetada.',
          promptTitle: 'Margem antes da fala',
          promptBody: 'Introduza de 0 a 10000 milissegundos ou deixe em branco.',
        },
        idleTimeoutMs: {
          title: 'Tempo limite de resposta em inatividade',
          subtitle: 'Se quiser, peça à xAI para iniciar uma resposta após este silêncio.',
          promptTitle: 'Tempo limite de resposta em inatividade',
          promptBody: 'Introduza de 1 a 600000 milissegundos ou deixe em branco para desativar as respostas automáticas em inatividade.',
          confirmTitle: 'Ativar as respostas automáticas em inatividade?',
          confirmBody: 'Após o silêncio configurado, a xAI pode criar uma resposta por iniciativa própria e consumir utilização da API.',
          confirmAction: 'Ativar',
        },
      },
      transcriptionModel: {
        title: 'Modelo de transcrição',
        subtitle: 'Modelo opcional de transcrição da entrada.',
        promptTitle: 'Modelo de transcrição',
        promptBody: 'Introduza um id de modelo ou deixe em branco para o valor do fornecedor.',
      },
      reasoning: { title: 'Raciocínio', subtitle: 'Escolha o nível de raciocínio para os modelos suportados.' },
      outputSpeed: {
        title: 'Velocidade da fala',
        subtitle: 'Ajuste a velocidade com que o fornecedor fala.',
        promptTitle: 'Velocidade da fala',
        promptBody: 'Introduza um valor de 0.7 a 1.5.',
      },
      languageHint: {
        title: 'Sugestão de idioma',
        subtitle: 'Se quiser, ajude a transcrição a identificar o seu idioma.',
        promptTitle: 'Sugestão de idioma',
        promptBody: 'Escolha um idioma suportado.',
      },
      keyterms: {
        title: 'Termos-chave',
        subtitle: 'Nomes e termos do domínio que a transcrição deve reconhecer.',
        promptTitle: 'Termos-chave',
        promptBody: 'Introduza até 100 termos separados por vírgulas ou por mudanças de linha.',
      },
    },
    options: {
      pinned: 'Versão fixada',
      movingAlias: 'Acompanha automaticamente as atualizações do fornecedor',
      automatic: 'Automático',
      custom: 'Personalizado…',
      server_vad: 'Deteção de atividade de voz no servidor',
      semantic_vad: 'Deteção semântica do fim da fala',
      manual: 'Manual',
      high: 'Alto',
      none: 'Nenhum',
    },
    catalog: {
      credentialRequired: 'Adicione uma chave de API para carregar as vozes',
      retry: 'Não foi possível carregar as vozes — tentar de novo',
      empty: 'Não há vozes disponíveis para esta conta',
      preview: ({ voice }) => `Ouvir ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Acompanhar o modelo mais recente?',
      confirmBody: 'Um alias de modelo móvel pode mudar de comportamento quando o fornecedor o atualiza. Pode voltar a uma versão fixada quando quiser.',
      confirmAction: 'Usar o mais recente',
    },
    links: {
      title: 'Recursos do fornecedor',
      account: { title: 'Abrir a conta do fornecedor', subtitle: 'Faça a gestão da sua conta no fornecedor.' },
      apiKeys: { title: 'Abrir as chaves de API', subtitle: 'Crie, rode ou revogue chaves de API do fornecedor.' },
      privacy: { title: 'Política de privacidade do fornecedor', subtitle: 'Veja como o fornecedor trata os dados de voz.' },
    },
    disconnect: {
      title: 'Desligar a voz em tempo real',
      subtitle: 'Remova a chave de API deste fornecedor da máquina selecionada.',
      confirmTitle: 'Desligar o fornecedor?',
      confirmBody: 'Isto remove a chave de API guardada da máquina de execução selecionada.',
    },
    unavailable: {
      title: 'Voz em tempo real indisponível',
      rowTitle: 'Não foi possível carregar as definições',
      provider: 'A contribuição do fornecedor está indisponível ou é incompatível.',
      invalid: 'As definições guardadas do fornecedor são inválidas.',
      needs_migration: 'Estas definições precisam de uma migração suportada antes de poderem ser editadas.',
      unsupported_version: 'Estas definições foram escritas por uma versão mais recente do Happier.',
    },
  }),
  ca: defineVoiceRealtimeProviderSetup('ca', {
    xai: {
      setup: { footer: 'La teva clau de l’API d’xAI es desa com a secret desat sincronitzat als secrets del teu compte de Happier. Només es materialitza per a l’operació acotada d’xAI Realtime.' },
      credential: { promptBody: 'Enganxa una clau de l’API d’xAI. Happier la protegeix com a secret desat sincronitzat i només la materialitza per a l’operació acotada d’xAI Realtime.' },
    },
    setup: {
      title: 'Configuració de la veu en temps real',
      footer: 'La teva clau de l’API es desa a la màquina d’execució seleccionada i mai no s’inclou a la configuració de veu sincronitzada.',
    },
    credential: {
      title: 'Clau de l’API desada',
      promptTitle: 'Connecta la veu en temps real',
      promptBody: 'Enganxa una clau de l’API d’OpenAI Platform. Es protegeix als secrets sincronitzats del teu compte i només es materialitza en emetre credencials de client de Realtime de curta durada.',
    },
    authentication: {
      sectionTitle: 'Autenticació d’OpenAI Realtime',
      title: 'Font d’autenticació',
      subtitle: 'Tria exactament una font. Happier mai no recorre a una altra clau ni a un altre compte.',
      footer: 'L’ús de l’API d’OpenAI Realtime el factura OpenAI Platform. Una subscripció a ChatGPT o Codex no implica facturació ni accés a l’API de Realtime. A la conversa per WebRTC només s’hi passen credencials de client de curta durada.',
      savedSecret: {
        title: 'Clau de l’API de veu desada',
        subtitle: 'Utilitza la clau de l’API desada als secrets del compte de Happier Voice. No cal cap dimoni.',
      },
      openAiApiKey: {
        title: 'Servei connectat d’OpenAI',
        subtitle: 'Utilitza el perfil o grup de comptes amb clau de l’API d’OpenAI estàndard seleccionat mitjançant la màquina triada i el seu dimoni connectat.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (experimental)',
        subtitle: 'Utilitza el perfil o grup de comptes de Codex OAuth seleccionat mitjançant la màquina triada i el seu dimoni connectat. Happier mai no recorre a una altra clau ni a un altre compte.',
      },
      account: {
        title: 'Compte connectat',
        subtitle: 'Tria el perfil o grup de comptes exacte que s’utilitzarà a la propera conversa.',
      },
      chooseAccount: 'Tria un compte',
      referenceRequired: 'Tria un perfil o grup de comptes connectat.',
      connected: 'Compte connectat a punt',
      unavailable: 'El compte seleccionat no està disponible o cal tornar-lo a connectar',
    },
    invalidValue: 'Aquest proveïdor no admet aquest valor.',
    advanced: { show: 'Mostra la configuració avançada', hide: 'Amaga la configuració avançada' },
    fields: {
      model: { title: 'Model', subtitle: 'Tria el model de veu en temps real.' },
      voice: { title: 'Veu', subtitle: 'Tria la veu que s’utilitza a les respostes.' },
      instructions: {
        title: 'Instruccions de veu',
        subtitle: 'Instruccions opcionals de comportament i personalitat.',
        promptTitle: 'Instruccions de veu',
        promptBody: 'Escriu instruccions opcionals per a aquesta sessió de veu.',
      },
      turnDetection: {
        title: 'Detecció de torn',
        subtitle: 'Tria com detecta el proveïdor el final del teu torn.',
        threshold: {
          title: 'Llindar de VAD',
          subtitle: 'Sensibilitat a l’activitat de veu; deixa-ho en blanc per al valor del proveïdor.',
          promptTitle: 'Llindar de VAD',
          promptBody: 'Introdueix un valor de 0.1 a 0.9, o deixa-ho en blanc.',
        },
        silenceDurationMs: {
          title: 'Durada del silenci',
          subtitle: 'Mil·lisegons de silenci abans d’acabar un torn.',
          promptTitle: 'Durada del silenci',
          promptBody: 'Introdueix de 0 a 10000 mil·lisegons, o deixa-ho en blanc.',
        },
        prefixPaddingMs: {
          title: 'Marge abans de la parla',
          subtitle: 'Mil·lisegons que es conserven abans de la parla detectada.',
          promptTitle: 'Marge abans de la parla',
          promptBody: 'Introdueix de 0 a 10000 mil·lisegons, o deixa-ho en blanc.',
        },
        idleTimeoutMs: {
          title: 'Temps d’espera de resposta per inactivitat',
          subtitle: 'Si vols, demana a xAI que iniciï una resposta després d’aquest silenci.',
          promptTitle: 'Temps d’espera de resposta per inactivitat',
          promptBody: 'Introdueix de 1 a 600000 mil·lisegons, o deixa-ho en blanc per desactivar les respostes automàtiques per inactivitat.',
          confirmTitle: 'Vols activar les respostes automàtiques per inactivitat?',
          confirmBody: 'Després del silenci configurat, xAI pot crear una resposta per iniciativa pròpia i consumir ús de l’API.',
          confirmAction: 'Activa',
        },
      },
      transcriptionModel: {
        title: 'Model de transcripció',
        subtitle: 'Model opcional de transcripció de l’entrada.',
        promptTitle: 'Model de transcripció',
        promptBody: 'Introdueix un id de model, o deixa-ho en blanc per al valor del proveïdor.',
      },
      reasoning: { title: 'Raonament', subtitle: 'Tria l’esforç de raonament per als models compatibles.' },
      outputSpeed: {
        title: 'Velocitat de parla',
        subtitle: 'Ajusta la velocitat de parla del proveïdor.',
        promptTitle: 'Velocitat de parla',
        promptBody: 'Introdueix un valor de 0.7 a 1.5.',
      },
      languageHint: {
        title: 'Pista d’idioma',
        subtitle: 'Si vols, ajuda la transcripció a identificar el teu idioma.',
        promptTitle: 'Pista d’idioma',
        promptBody: 'Tria un idioma compatible.',
      },
      keyterms: {
        title: 'Termes clau',
        subtitle: 'Noms i termes del domini que la transcripció hauria de reconèixer.',
        promptTitle: 'Termes clau',
        promptBody: 'Introdueix fins a 100 termes separats per comes o salts de línia.',
      },
    },
    options: {
      pinned: 'Versió fixada',
      movingAlias: 'Segueix automàticament les actualitzacions del proveïdor',
      automatic: 'Automàtic',
      custom: 'Personalitzat…',
      server_vad: 'Detecció d’activitat de veu al servidor',
      semantic_vad: 'Detecció semàntica de torn',
      manual: 'Manual',
      high: 'Alt',
      none: 'Cap',
    },
    catalog: {
      credentialRequired: 'Afegeix una clau de l’API per carregar les veus',
      retry: 'No s’han pogut carregar les veus: torna-ho a provar',
      empty: 'No hi ha cap veu disponible per a aquest compte',
      preview: ({ voice }) => `Escolta ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Vols seguir el model més recent?',
      confirmBody: 'Un àlies de model mòbil pot canviar de comportament quan el proveïdor l’actualitzi. Pots tornar a una versió fixada en qualsevol moment.',
      confirmAction: 'Usa el més recent',
    },
    links: {
      title: 'Recursos del proveïdor',
      account: { title: 'Obre el compte del proveïdor', subtitle: 'Gestiona el teu compte al proveïdor.' },
      apiKeys: { title: 'Obre les claus de l’API', subtitle: 'Crea, renova o revoca claus de l’API del proveïdor.' },
      privacy: { title: 'Política de privadesa del proveïdor', subtitle: 'Consulta com tracta el proveïdor les dades de veu.' },
    },
    disconnect: {
      title: 'Desconnecta la veu en temps real',
      subtitle: 'Suprimeix la clau de l’API d’aquest proveïdor de la màquina seleccionada.',
      confirmTitle: 'Vols desconnectar el proveïdor?',
      confirmBody: 'Això suprimeix la clau de l’API desada de la màquina d’execució seleccionada.',
    },
    unavailable: {
      title: 'Veu en temps real no disponible',
      rowTitle: 'No s’ha pogut carregar la configuració',
      provider: 'La contribució del proveïdor no està disponible o no és compatible.',
      invalid: 'La configuració desada del proveïdor no és vàlida.',
      needs_migration: 'Aquesta configuració necessita una migració compatible abans de poder-se editar.',
      unsupported_version: 'Aquesta configuració l’ha escrita una versió més recent de Happier.',
    },
  }),
  'zh-Hans': defineVoiceRealtimeProviderSetup('zh-Hans', {
    xai: {
      setup: { footer: '你的 xAI API 密钥以同步的已保存密钥形式存放在 Happier 账户密钥中，只在受限的 xAI Realtime 操作中才会被取出使用。' },
      credential: { promptBody: '粘贴 xAI API 密钥。Happier 会把它作为同步的已保存密钥加以保护，只在受限的 xAI Realtime 操作中才会取出使用。' },
    },
    setup: {
      title: '实时语音设置',
      footer: '你的 API 密钥保存在所选执行机器上，绝不会写入同步的语音设置。',
    },
    credential: {
      title: '已保存的 API 密钥',
      promptTitle: '连接实时语音',
      promptBody: '粘贴 OpenAI Platform API 密钥。它会受同步账户密钥保护，只在签发短期 Realtime 客户端凭据时才会取出使用。',
    },
    authentication: {
      sectionTitle: 'OpenAI Realtime 身份验证',
      title: '身份验证来源',
      subtitle: '请只选择一个来源。Happier 绝不会退回到其他密钥或账户。',
      footer: 'OpenAI Realtime API 的用量由 OpenAI Platform 计费。ChatGPT 或 Codex 订阅并不代表拥有 Realtime API 的计费或访问权限。传递给 WebRTC 对话的只有短期客户端凭据。',
      savedSecret: {
        title: '已保存的语音 API 密钥',
        subtitle: '使用保存在 Happier Voice 账户密钥中的 API 密钥。无需守护进程。',
      },
      openAiApiKey: {
        title: 'OpenAI 已连接服务',
        subtitle: '通过所选机器及其已连接的守护进程，使用选定的标准 OpenAI API 密钥配置或账户组。',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth（实验性）',
        subtitle: '通过所选机器及其已连接的守护进程，使用选定的 Codex OAuth 配置或账户组。Happier 绝不会退回到其他密钥或账户。',
      },
      account: {
        title: '已连接账户',
        subtitle: '选择下一次对话所使用的具体配置或账户组。',
      },
      chooseAccount: '选择账户',
      referenceRequired: '请选择一个已连接的配置或账户组。',
      connected: '已连接账户就绪',
      unavailable: '所选账户不可用或需要重新连接',
    },
    invalidValue: '此提供商不支持该值。',
    advanced: { show: '显示高级设置', hide: '隐藏高级设置' },
    fields: {
      model: { title: '模型', subtitle: '选择实时语音模型。' },
      voice: { title: '语音', subtitle: '选择用于回复的语音。' },
      instructions: {
        title: '语音指令',
        subtitle: '可选的行为与个性指令。',
        promptTitle: '语音指令',
        promptBody: '为这次语音会话输入可选指令。',
      },
      turnDetection: {
        title: '话轮检测',
        subtitle: '选择提供商如何判断你说完了。',
        threshold: {
          title: 'VAD 阈值',
          subtitle: '语音活动灵敏度；留空则使用提供商默认值。',
          promptTitle: 'VAD 阈值',
          promptBody: '请输入 0.1 到 0.9 之间的值，或留空。',
        },
        silenceDurationMs: {
          title: '静音时长',
          subtitle: '结束一轮发言前需要的静音毫秒数。',
          promptTitle: '静音时长',
          promptBody: '请输入 0–10000 毫秒，或留空。',
        },
        prefixPaddingMs: {
          title: '语音前置留白',
          subtitle: '在检测到语音之前保留的毫秒数。',
          promptTitle: '语音前置留白',
          promptBody: '请输入 0–10000 毫秒，或留空。',
        },
        idleTimeoutMs: {
          title: '空闲回复超时',
          subtitle: '可选：静音达到此时长后，请 xAI 主动开始回复。',
          promptTitle: '空闲回复超时',
          promptBody: '请输入 1–600000 毫秒，或留空以关闭自动空闲回复。',
          confirmTitle: '要启用自动空闲回复吗？',
          confirmBody: '在设定的静音之后，xAI 可能会主动生成回复并消耗 API 用量。',
          confirmAction: '启用',
        },
      },
      transcriptionModel: {
        title: '转写模型',
        subtitle: '可选的输入转写模型。',
        promptTitle: '转写模型',
        promptBody: '请输入模型 id，或留空以使用提供商默认值。',
      },
      reasoning: { title: '推理', subtitle: '为支持的模型选择推理强度。' },
      outputSpeed: {
        title: '语速',
        subtitle: '调整提供商的说话速度。',
        promptTitle: '语速',
        promptBody: '请输入 0.7 到 1.5 之间的值。',
      },
      languageHint: {
        title: '语言提示',
        subtitle: '可选：帮助转写识别你使用的语言。',
        promptTitle: '语言提示',
        promptBody: '请选择一种受支持的语言。',
      },
      keyterms: {
        title: '关键术语',
        subtitle: '希望转写能够识别的人名和领域术语。',
        promptTitle: '关键术语',
        promptBody: '最多输入 100 个术语，用逗号或换行分隔。',
      },
    },
    options: {
      pinned: '固定版本',
      movingAlias: '自动跟随提供商更新',
      automatic: '自动',
      custom: '自定义…',
      server_vad: '服务端语音活动检测',
      semantic_vad: '语义话轮检测',
      manual: '手动',
      high: '高',
      none: '无',
    },
    catalog: {
      credentialRequired: '添加 API 密钥以加载语音',
      retry: '无法加载语音 — 重试',
      empty: '此账户没有可用的语音',
      preview: ({ voice }) => `试听 ${voice}`,
    },
    movingAlias: {
      confirmTitle: '要跟随最新模型吗？',
      confirmBody: '浮动模型别名会在提供商更新时改变行为。你随时可以切回固定版本。',
      confirmAction: '使用最新版',
    },
    links: {
      title: '提供商资源',
      account: { title: '打开提供商账户', subtitle: '管理你在提供商处的账户。' },
      apiKeys: { title: '打开 API 密钥', subtitle: '创建、轮换或吊销提供商的 API 密钥。' },
      privacy: { title: '提供商隐私政策', subtitle: '了解提供商如何处理语音数据。' },
    },
    disconnect: {
      title: '断开实时语音',
      subtitle: '从所选机器移除此提供商的 API 密钥。',
      confirmTitle: '要断开此提供商吗？',
      confirmBody: '这会从所选执行机器移除已保存的 API 密钥。',
    },
    unavailable: {
      title: '实时语音不可用',
      rowTitle: '无法加载设置',
      provider: '提供商的插件不可用或不兼容。',
      invalid: '已保存的提供商设置无效。',
      needs_migration: '这些设置需要先完成受支持的迁移才能编辑。',
      unsupported_version: '这些设置由更新版本的 Happier 写入。',
    },
  }),
  'zh-Hant': defineVoiceRealtimeProviderSetup('zh-Hant', {
    xai: {
      setup: { footer: '你的 xAI API 金鑰以同步的已儲存密鑰形式存放在 Happier 帳戶密鑰中，只在受限的 xAI Realtime 操作中才會被取出使用。' },
      credential: { promptBody: '貼上 xAI API 金鑰。Happier 會把它作為同步的已儲存密鑰加以保護，只在受限的 xAI Realtime 操作中才會取出使用。' },
    },
    setup: {
      title: '即時語音設定',
      footer: '你的 API 金鑰儲存在所選執行機器上，絕不會寫入同步的語音設定。',
    },
    credential: {
      title: '已儲存的 API 金鑰',
      promptTitle: '連接即時語音',
      promptBody: '貼上 OpenAI Platform API 金鑰。它會受同步帳戶密鑰保護，只在簽發短期 Realtime 用戶端憑證時才會取出使用。',
    },
    authentication: {
      sectionTitle: 'OpenAI Realtime 驗證',
      title: '驗證來源',
      subtitle: '請只選擇一個來源。Happier 絕不會退回到其他金鑰或帳戶。',
      footer: 'OpenAI Realtime API 的用量由 OpenAI Platform 計費。ChatGPT 或 Codex 訂閱並不代表擁有 Realtime API 的計費或存取權。傳遞給 WebRTC 對話的只有短期用戶端憑證。',
      savedSecret: {
        title: '已儲存的語音 API 金鑰',
        subtitle: '使用儲存在 Happier Voice 帳戶密鑰中的 API 金鑰。不需要守護程序。',
      },
      openAiApiKey: {
        title: 'OpenAI 已連接服務',
        subtitle: '透過所選機器及其已連接的守護程序，使用選定的標準 OpenAI API 金鑰設定檔或帳戶群組。',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth（實驗性）',
        subtitle: '透過所選機器及其已連接的守護程序，使用選定的 Codex OAuth 設定檔或帳戶群組。Happier 絕不會退回到其他金鑰或帳戶。',
      },
      account: {
        title: '已連接帳戶',
        subtitle: '選擇下一次對話所使用的確切設定檔或帳戶群組。',
      },
      chooseAccount: '選擇帳戶',
      referenceRequired: '請選擇一個已連接的設定檔或帳戶群組。',
      connected: '已連接帳戶就緒',
      unavailable: '所選帳戶無法使用或需要重新連接',
    },
    invalidValue: '此供應商不支援該值。',
    advanced: { show: '顯示進階設定', hide: '隱藏進階設定' },
    fields: {
      model: { title: '模型', subtitle: '選擇即時語音模型。' },
      voice: { title: '語音', subtitle: '選擇用於回覆的語音。' },
      instructions: {
        title: '語音指示',
        subtitle: '選填的行為與個性指示。',
        promptTitle: '語音指示',
        promptBody: '為這次語音工作階段輸入選填指示。',
      },
      turnDetection: {
        title: '輪次偵測',
        subtitle: '選擇供應商如何判斷你說完了。',
        threshold: {
          title: 'VAD 門檻',
          subtitle: '語音活動靈敏度；留空則使用供應商預設值。',
          promptTitle: 'VAD 門檻',
          promptBody: '請輸入 0.1 到 0.9 之間的值，或留空。',
        },
        silenceDurationMs: {
          title: '靜音長度',
          subtitle: '結束一輪發言前需要的靜音毫秒數。',
          promptTitle: '靜音長度',
          promptBody: '請輸入 0–10000 毫秒，或留空。',
        },
        prefixPaddingMs: {
          title: '語音前置留白',
          subtitle: '在偵測到語音之前保留的毫秒數。',
          promptTitle: '語音前置留白',
          promptBody: '請輸入 0–10000 毫秒，或留空。',
        },
        idleTimeoutMs: {
          title: '閒置回覆逾時',
          subtitle: '選填：靜音達到此長度後，請 xAI 主動開始回覆。',
          promptTitle: '閒置回覆逾時',
          promptBody: '請輸入 1–600000 毫秒，或留空以關閉自動閒置回覆。',
          confirmTitle: '要啟用自動閒置回覆嗎？',
          confirmBody: '在設定的靜音之後，xAI 可能會主動產生回覆並消耗 API 用量。',
          confirmAction: '啟用',
        },
      },
      transcriptionModel: {
        title: '轉錄模型',
        subtitle: '選填的輸入轉錄模型。',
        promptTitle: '轉錄模型',
        promptBody: '請輸入模型 id，或留空以使用供應商預設值。',
      },
      reasoning: { title: '推理', subtitle: '為支援的模型選擇推理強度。' },
      outputSpeed: {
        title: '語速',
        subtitle: '調整供應商的說話速度。',
        promptTitle: '語速',
        promptBody: '請輸入 0.7 到 1.5 之間的值。',
      },
      languageHint: {
        title: '語言提示',
        subtitle: '選填：協助轉錄辨識你使用的語言。',
        promptTitle: '語言提示',
        promptBody: '請選擇一種支援的語言。',
      },
      keyterms: {
        title: '關鍵術語',
        subtitle: '希望轉錄能夠辨識的人名與領域術語。',
        promptTitle: '關鍵術語',
        promptBody: '最多輸入 100 個術語，以逗號或換行分隔。',
      },
    },
    options: {
      pinned: '固定版本',
      movingAlias: '自動跟隨供應商更新',
      automatic: '自動',
      custom: '自訂…',
      server_vad: '伺服器端語音活動偵測',
      semantic_vad: '語意輪次偵測',
      manual: '手動',
      high: '高',
      none: '無',
    },
    catalog: {
      credentialRequired: '新增 API 金鑰以載入語音',
      retry: '無法載入語音 — 重試',
      empty: '此帳戶沒有可用的語音',
      preview: ({ voice }) => `試聽 ${voice}`,
    },
    movingAlias: {
      confirmTitle: '要跟隨最新模型嗎？',
      confirmBody: '浮動模型別名會在供應商更新時改變行為。你隨時可以切回固定版本。',
      confirmAction: '使用最新版',
    },
    links: {
      title: '供應商資源',
      account: { title: '開啟供應商帳戶', subtitle: '管理你在供應商處的帳戶。' },
      apiKeys: { title: '開啟 API 金鑰', subtitle: '建立、輪替或撤銷供應商的 API 金鑰。' },
      privacy: { title: '供應商隱私權政策', subtitle: '了解供應商如何處理語音資料。' },
    },
    disconnect: {
      title: '中斷即時語音',
      subtitle: '從所選機器移除此供應商的 API 金鑰。',
      confirmTitle: '要中斷此供應商嗎？',
      confirmBody: '這會從所選執行機器移除已儲存的 API 金鑰。',
    },
    unavailable: {
      title: '即時語音無法使用',
      rowTitle: '無法載入設定',
      provider: '供應商的外掛程式無法使用或不相容。',
      invalid: '已儲存的供應商設定無效。',
      needs_migration: '這些設定需要先完成支援的移轉才能編輯。',
      unsupported_version: '這些設定由較新版本的 Happier 寫入。',
    },
  }),
  ja: defineVoiceRealtimeProviderSetup('ja', {
    xai: {
      setup: { footer: 'xAI の API キーは、同期される保存済みシークレットとして Happier アカウントのシークレットに保管され、限定された xAI Realtime の処理のときにだけ展開されます。' },
      credential: { promptBody: 'xAI の API キーを貼り付けてください。Happier は同期される保存済みシークレットとして保護し、限定された xAI Realtime の処理のときにだけ展開します。' },
    },
    setup: {
      title: 'リアルタイム音声の設定',
      footer: 'API キーは選択した実行マシンに保存され、同期される音声設定に含まれることはありません。',
    },
    credential: {
      title: '保存済みの API キー',
      promptTitle: 'リアルタイム音声を接続',
      promptBody: 'OpenAI Platform の API キーを貼り付けてください。同期されるアカウントのシークレット内で保護され、短時間だけ有効な Realtime クライアント認証を発行するときにのみ展開されます。',
    },
    authentication: {
      sectionTitle: 'OpenAI Realtime の認証',
      title: '認証のソース',
      subtitle: 'ソースはちょうど 1 つ選択してください。Happier が別のキーやアカウントにフォールバックすることはありません。',
      footer: 'OpenAI Realtime API の利用料は OpenAI Platform から請求されます。ChatGPT や Codex のサブスクリプションは、Realtime API の課金やアクセスを意味しません。WebRTC の会話に渡されるのは短時間だけ有効なクライアント認証のみです。',
      savedSecret: {
        title: '保存済みの音声 API キー',
        subtitle: 'Happier Voice アカウントのシークレットに保存された API キーを使用します。デーモンは不要です。',
      },
      openAiApiKey: {
        title: 'OpenAI 接続済みサービス',
        subtitle: '選択したマシンとその接続済みデーモンを介して、選択した標準の OpenAI API キープロファイルまたはアカウントグループを使用します。',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth（実験的）',
        subtitle: '選択したマシンとその接続済みデーモンを介して、選択した Codex OAuth プロファイルまたはアカウントグループを使用します。Happier が別のキーやアカウントにフォールバックすることはありません。',
      },
      account: {
        title: '接続済みアカウント',
        subtitle: '次の会話で使用するプロファイルまたはアカウントグループを正確に選択します。',
      },
      chooseAccount: 'アカウントを選択',
      referenceRequired: '接続済みのプロファイルまたはアカウントグループを選択してください。',
      connected: '接続済みアカウントの準備ができました',
      unavailable: '選択したアカウントは利用できないか、再接続が必要です',
    },
    invalidValue: 'この値はこのプロバイダーではサポートされていません。',
    advanced: { show: '詳細設定を表示', hide: '詳細設定を非表示' },
    fields: {
      model: { title: 'モデル', subtitle: 'リアルタイム音声モデルを選択します。' },
      voice: { title: '音声', subtitle: '応答に使う音声を選択します。' },
      instructions: {
        title: '音声インストラクション',
        subtitle: '振る舞いや性格に関する任意のインストラクション。',
        promptTitle: '音声インストラクション',
        promptBody: 'この音声セッション向けの任意のインストラクションを入力します。',
      },
      turnDetection: {
        title: 'ターン検出',
        subtitle: 'あなたの発話の終わりをプロバイダーがどう判定するかを選択します。',
        threshold: {
          title: 'VAD しきい値',
          subtitle: '音声アクティビティの感度。空欄にするとプロバイダーの既定値になります。',
          promptTitle: 'VAD しきい値',
          promptBody: '0.1 から 0.9 の値を入力するか、空欄のままにしてください。',
        },
        silenceDurationMs: {
          title: '無音の長さ',
          subtitle: 'ターンを終了するまでの無音のミリ秒数。',
          promptTitle: '無音の長さ',
          promptBody: '0〜10000 ミリ秒を入力するか、空欄のままにしてください。',
        },
        prefixPaddingMs: {
          title: '発話前のパディング',
          subtitle: '検出された発話の前に保持するミリ秒数。',
          promptTitle: '発話前のパディング',
          promptBody: '0〜10000 ミリ秒を入力するか、空欄のままにしてください。',
        },
        idleTimeoutMs: {
          title: 'アイドル応答のタイムアウト',
          subtitle: '任意: この長さの無音のあとに xAI から応答を開始させます。',
          promptTitle: 'アイドル応答のタイムアウト',
          promptBody: '1〜600000 ミリ秒を入力するか、空欄にすると自動アイドル応答が無効になります。',
          confirmTitle: '自動アイドル応答を有効にしますか？',
          confirmBody: '設定した無音のあと、xAI が自発的に応答を作成し、API の利用量を消費する場合があります。',
          confirmAction: '有効にする',
        },
      },
      transcriptionModel: {
        title: '文字起こしモデル',
        subtitle: '任意の入力文字起こしモデル。',
        promptTitle: '文字起こしモデル',
        promptBody: 'モデル ID を入力するか、空欄にするとプロバイダーの既定値になります。',
      },
      reasoning: { title: '推論', subtitle: '対応モデルでの推論の強度を選択します。' },
      outputSpeed: {
        title: '話す速さ',
        subtitle: 'プロバイダーが話す速さを調整します。',
        promptTitle: '話す速さ',
        promptBody: '0.7 から 1.5 の値を入力してください。',
      },
      languageHint: {
        title: '言語ヒント',
        subtitle: '任意: 文字起こしがあなたの言語を判別しやすくします。',
        promptTitle: '言語ヒント',
        promptBody: '対応している言語を選択してください。',
      },
      keyterms: {
        title: 'キーワード',
        subtitle: '文字起こしに認識させたい固有名詞や専門用語。',
        promptTitle: 'キーワード',
        promptBody: 'カンマまたは改行で区切って、最大 100 個の用語を入力してください。',
      },
    },
    options: {
      pinned: '固定バージョン',
      movingAlias: 'プロバイダーの更新に自動で追従',
      automatic: '自動',
      custom: 'カスタム…',
      server_vad: 'サーバー側の音声アクティビティ検出',
      semantic_vad: '意味に基づくターン検出',
      manual: '手動',
      high: '高',
      none: 'なし',
    },
    catalog: {
      credentialRequired: 'API キーを追加すると音声を読み込めます',
      retry: '音声を読み込めませんでした — 再試行',
      empty: 'このアカウントで利用できる音声はありません',
      preview: ({ voice }) => `${voice} を試聴`,
    },
    movingAlias: {
      confirmTitle: '最新モデルに追従しますか？',
      confirmBody: '可動のモデルエイリアスは、プロバイダーが更新すると挙動が変わることがあります。いつでも固定バージョンに戻せます。',
      confirmAction: '最新を使う',
    },
    links: {
      title: 'プロバイダーのリソース',
      account: { title: 'プロバイダーのアカウントを開く', subtitle: 'プロバイダー側のアカウントを管理します。' },
      apiKeys: { title: 'API キーを開く', subtitle: 'プロバイダーの API キーを作成・更新・失効させます。' },
      privacy: { title: 'プロバイダーのプライバシーポリシー', subtitle: 'プロバイダーが音声データをどう扱うかを確認します。' },
    },
    disconnect: {
      title: 'リアルタイム音声を切断',
      subtitle: 'このプロバイダーの API キーを選択したマシンから削除します。',
      confirmTitle: 'プロバイダーを切断しますか？',
      confirmBody: '選択した実行マシンから、保存済みの API キーを削除します。',
    },
    unavailable: {
      title: 'リアルタイム音声を利用できません',
      rowTitle: '設定を読み込めませんでした',
      provider: 'プロバイダーのコントリビューションが利用できないか、互換性がありません。',
      invalid: '保存されているプロバイダー設定が正しくありません。',
      needs_migration: 'この設定を編集するには、対応するマイグレーションが必要です。',
      unsupported_version: 'この設定はより新しいバージョンの Happier によって書き込まれました。',
    },
  }),
} as const;
